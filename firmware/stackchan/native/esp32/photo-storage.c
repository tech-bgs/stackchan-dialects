/*
 * M5Stack CoreS3 microSD — FAT at /sdcard via ESP-IDF SDSPI + VFS.
 *
 * TF slot (SPI3, shared with ILI9342): MOSI 37, MISO 35, SCK 36, CS 4
 * LCD DC on GPIO35 conflicts with SD MISO — reconfigure GPIO35 before SD I/O.
 */

#include "xsmc.h"
#include "xsHost.h"
#include "mc.defines.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_err.h"
#include "esp_log.h"

/* ESP-IDF 6.x headers (Moddable INC_DIRS omit components/sdmmc). */
#if __has_include("sd_protocol_types.h")
#include "sd_protocol_types.h"
#else
#include "../../../../../../esp/esp-idf/components/sdmmc/include/sd_protocol_types.h"
#endif
#if __has_include("driver/sdspi_host.h")
#include "driver/sdspi_host.h"
#else
#include "../../../../../../esp/esp-idf/components/esp_driver_sdspi/include/driver/sdspi_host.h"
#endif
#if __has_include("sdmmc_cmd.h")
#include "sdmmc_cmd.h"
#else
#include "../../../../../../esp/esp-idf/components/sdmmc/include/sdmmc_cmd.h"
#endif

#include "esp_vfs_fat.h"
#include "driver/gpio.h"
#include "driver/spi_common.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define PHOTO_SD_MOUNT_POINT "/sdcard"
#define PHOTO_SD_MAX_PATH 256
#define PHOTO_STORAGE_TAG "PhotoSD"

#ifndef MODDEF_PHOTO_SD_MOSI
	#define MODDEF_PHOTO_SD_MOSI 37
#endif
#ifndef MODDEF_PHOTO_SD_MISO
	#define MODDEF_PHOTO_SD_MISO 35
#endif
#ifndef MODDEF_PHOTO_SD_SCK
	#define MODDEF_PHOTO_SD_SCK 36
#endif
#ifndef MODDEF_PHOTO_SD_CS
	#define MODDEF_PHOTO_SD_CS 4
#endif
#ifndef MODDEF_PHOTO_SD_MAX_FREQ_KHZ
	#define MODDEF_PHOTO_SD_MAX_FREQ_KHZ 400
#endif
#ifndef MODDEF_PHOTO_SD_CMD_TIMEOUT_MS
	#define MODDEF_PHOTO_SD_CMD_TIMEOUT_MS 10000
#endif
#ifndef MODDEF_PHOTO_SD_BUS_SETTLE_MS
	#define MODDEF_PHOTO_SD_BUS_SETTLE_MS 100
#endif

static bool g_sdMounted = false;
static sdmmc_card_t *g_sdCard = NULL;
/** Set when this module's spi_bus_initialize() succeeded (not ESP_ERR_INVALID_STATE). */
static bool g_photoSdSpiBusOwned = false;
static char g_photoStorageErrBuf[64];

static void photoStorageSetError(xsMachine *the, const char *message);

/* Moddable builds often disable CONFIG_ESP_ERR_TO_NAME_LOOKUP; esp_err_to_name() then
 * always returns "UNKNOWN ERROR". esp_err_to_name_r() still appends 0x…(dec). */
static void photoStorageFormatEspErr(esp_err_t err, char *buf, size_t len)
{
	if (len == 0)
		return;
	buf[0] = '\0';
	esp_err_to_name_r(err, buf, len);
	if (strncmp(buf, "UNKNOWN ERROR ", 14) == 0) {
		memmove(buf, buf + 14, strlen(buf + 14) + 1);
		return;
	}
	if (strcmp(buf, "UNKNOWN ERROR") == 0 || strcmp(buf, "ERROR") == 0)
		snprintf(buf, len, "0x%08x", (unsigned)err);
}

static void photoStorageSetEspError(xsMachine *the, esp_err_t err)
{
	photoStorageFormatEspErr(err, g_photoStorageErrBuf, sizeof(g_photoStorageErrBuf));
	photoStorageSetError(the, g_photoStorageErrBuf);
}

static void photoSdPrepareSharedSpiBus(void)
{
	gpio_config_t cs_cfg = {
		.pin_bit_mask = 1ULL << MODDEF_PHOTO_SD_CS,
		.mode = GPIO_MODE_OUTPUT,
		.pull_up_en = GPIO_PULLUP_DISABLE,
		.pull_down_en = GPIO_PULLDOWN_DISABLE,
		.intr_type = GPIO_INTR_DISABLE,
	};
	gpio_config(&cs_cfg);
	gpio_set_level(MODDEF_PHOTO_SD_CS, 1);

	/* GPIO35 is LCD DC when the display is active — reclaim as SD MISO before SPI I/O. */
	gpio_reset_pin(MODDEF_PHOTO_SD_MISO);
	gpio_config_t miso_cfg = {
		.pin_bit_mask = 1ULL << MODDEF_PHOTO_SD_MISO,
		.mode = GPIO_MODE_INPUT,
		.pull_up_en = GPIO_PULLUP_ENABLE,
		.pull_down_en = GPIO_PULLDOWN_DISABLE,
		.intr_type = GPIO_INTR_DISABLE,
	};
	gpio_config(&miso_cfg);
	ESP_LOGI(PHOTO_STORAGE_TAG, "MISO GPIO%d input pull-up (shared SPI3 bus)", MODDEF_PHOTO_SD_MISO);
}

static void photoSdReleaseAfterFailedMount(spi_host_device_t host_slot)
{
	/* esp_vfs_fat_sdspi_mount frees card + sdspi host on failure; reclaim SPI bus
	   only when we called spi_bus_initialize() successfully in this module. */
	if (g_sdCard != NULL) {
		esp_err_t u = esp_vfs_fat_sdcard_unmount(PHOTO_SD_MOUNT_POINT, g_sdCard);
		if (u != ESP_OK)
			ESP_LOGW(PHOTO_STORAGE_TAG, "sdcard_unmount after failed mount: 0x%x", (unsigned)u);
		g_sdCard = NULL;
	}
	g_sdMounted = false;

	if (g_photoSdSpiBusOwned) {
		esp_err_t f = spi_bus_free(host_slot);
		ESP_LOGW(PHOTO_STORAGE_TAG, "spi_bus_free after failed mount: %s",
			f == ESP_OK ? "ok" : "err");
		g_photoSdSpiBusOwned = false;
	}
}

static esp_err_t ensurePhotoSdMounted(void)
{
	if (g_sdMounted) {
		photoSdPrepareSharedSpiBus();
		vTaskDelay(pdMS_TO_TICKS(MODDEF_PHOTO_SD_BUS_SETTLE_MS));
		return ESP_OK;
	}

	photoSdPrepareSharedSpiBus();
	vTaskDelay(pdMS_TO_TICKS(MODDEF_PHOTO_SD_BUS_SETTLE_MS));

	esp_vfs_fat_mount_config_t mount_config = {
		.format_if_mount_failed = false,
		.max_files = 5,
		.allocation_unit_size = 16 * 1024,
	};

	sdmmc_host_t host = SDSPI_HOST_DEFAULT();
	host.slot = SPI3_HOST;
	host.max_freq_khz = MODDEF_PHOTO_SD_MAX_FREQ_KHZ;
	host.command_timeout_ms = MODDEF_PHOTO_SD_CMD_TIMEOUT_MS;

	spi_bus_config_t bus_cfg = {
		.mosi_io_num = MODDEF_PHOTO_SD_MOSI,
		.miso_io_num = MODDEF_PHOTO_SD_MISO,
		.sclk_io_num = MODDEF_PHOTO_SD_SCK,
		.quadwp_io_num = -1,
		.quadhd_io_num = -1,
		.max_transfer_sz = 4096,
	};

	esp_err_t ret = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
	if (ret == ESP_OK) {
		g_photoSdSpiBusOwned = true;
	} else if (ret == ESP_ERR_INVALID_STATE) {
		ret = ESP_OK;
	} else {
		return ret;
	}

	sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
	slot_config.gpio_cs = MODDEF_PHOTO_SD_CS;
	slot_config.host_id = host.slot;
	/* Wait up to 127 ms for MISO high before each command (helps after LCD DC on GPIO35). */
	slot_config.wait_for_miso = 127;

	ESP_LOGI(PHOTO_STORAGE_TAG, "sdspi mount freq=%d kHz cmd_timeout=%d ms",
		host.max_freq_khz, host.command_timeout_ms);

	ret = esp_vfs_fat_sdspi_mount(PHOTO_SD_MOUNT_POINT, &host, &slot_config, &mount_config, &g_sdCard);
	if (ret == ESP_ERR_INVALID_STATE) {
		g_sdMounted = true;
		return ESP_OK;
	}
	if (ret != ESP_OK) {
		photoStorageFormatEspErr(ret, g_photoStorageErrBuf, sizeof(g_photoStorageErrBuf));
		ESP_LOGE(PHOTO_STORAGE_TAG, "esp_vfs_fat_sdspi_mount failed: %s", g_photoStorageErrBuf);
		photoSdReleaseAfterFailedMount(host.slot);
		return ret;
	}

	g_sdMounted = true;
	ESP_LOGI(PHOTO_STORAGE_TAG, "mounted %s", PHOTO_SD_MOUNT_POINT);
	return ESP_OK;
}

void xs_photo_storage_release_mount(xsMachine *the)
{
	photoSdReleaseAfterFailedMount(SPI3_HOST);
	(void)the;
}

static int mkdirOne(const char *path)
{
	int result = mkdir(path, 0755);
	return (result == 0 || errno == EEXIST) ? 0 : -1;
}

/* mkdir -p: mountPoint + relative path segments (no leading slash on relPath). */
static int photoMkdirRecursive(const char *mountPoint, const char *relPath)
{
	char path[PHOTO_SD_MAX_PATH];
	int n = snprintf(path, sizeof(path), "%s", mountPoint);
	if (n <= 0 || n >= (int)sizeof(path))
		return -1;

	const char *part = relPath;
	while (part && *part) {
		const char *slash = strchr(part, '/');
		size_t len = slash ? (size_t)(slash - part) : strlen(part);
		if (len == 0) {
			part = slash ? slash + 1 : NULL;
			continue;
		}
		if (n + 1 + (int)len >= (int)sizeof(path))
			return -1;
		path[n++] = '/';
		memcpy(path + n, part, len);
		n += (int)len;
		path[n] = '\0';
		if (mkdirOne(path) != 0)
			return -1;
		part = slash ? slash + 1 : NULL;
	}
	return 0;
}

static int photoMkdirForRelativeFile(const char *relPath)
{
	char dir[PHOTO_SD_MAX_PATH];
	size_t len = strlen(relPath);
	if (len >= sizeof(dir))
		return -1;
	memcpy(dir, relPath, len + 1);
	char *last = strrchr(dir, '/');
	if (!last)
		return 0;
	*last = '\0';
	if (dir[0] == '\0')
		return 0;
	return photoMkdirRecursive(PHOTO_SD_MOUNT_POINT, dir);
}

static void photoStorageSetError(xsMachine *the, const char *message)
{
	xsResult = xsString((char *)message);
}

void xs_photo_storage_ensure_directory(xsMachine *the)
{
	if (xsmcArgc < 1)
		return;

	const char *relDir = xsmcToString(xsArg(0));
	esp_err_t err = ensurePhotoSdMounted();
	if (err != ESP_OK) {
		photoStorageSetEspError(the, err);
		return;
	}
	if (photoMkdirRecursive(PHOTO_SD_MOUNT_POINT, relDir) != 0)
		photoStorageSetError(the, "mkdir failed");
}

void xs_photo_storage_write(xsMachine *the)
{
	if (xsmcArgc < 2) {
		photoStorageSetError(the, "missing args");
		return;
	}

	const char *relPath = xsmcToString(xsArg(0));
	void *data;
	xsUnsignedValue length;
	xsmcGetBufferReadable(xsArg(1), &data, &length);

	esp_err_t err = ensurePhotoSdMounted();
	if (err != ESP_OK) {
		photoStorageSetEspError(the, err);
		return;
	}
	if (photoMkdirForRelativeFile(relPath) != 0) {
		photoStorageSetError(the, "mkdir failed");
		return;
	}

	char fullPath[PHOTO_SD_MAX_PATH];
	if (snprintf(fullPath, sizeof(fullPath), "%s/%s", PHOTO_SD_MOUNT_POINT, relPath) >= (int)sizeof(fullPath)) {
		photoStorageSetError(the, "path too long");
		return;
	}

	FILE *file = fopen(fullPath, "wb");
	if (file == NULL) {
		photoStorageSetError(the, "open failed");
		return;
	}

	size_t written = fwrite(data, 1, (size_t)length, file);
	if (fclose(file) != 0 || written != (size_t)length) {
		photoStorageSetError(the, "write failed");
		return;
	}

	ESP_LOGI(PHOTO_STORAGE_TAG, "wrote %s (%u bytes)", fullPath, (unsigned)length);
}

void xs_photo_storage_diagnose(xsMachine *the)
{
	char report[384];
	int n = snprintf(report, sizeof(report),
		"[SD] mount=%s card=%s pins cs=%d mosi=%d miso=%d sck=%d freq=%d kHz cmd_to=%d ms",
		g_sdMounted ? "yes" : "no",
		g_sdCard ? "yes" : "no",
		MODDEF_PHOTO_SD_CS, MODDEF_PHOTO_SD_MOSI, MODDEF_PHOTO_SD_MISO, MODDEF_PHOTO_SD_SCK,
		MODDEF_PHOTO_SD_MAX_FREQ_KHZ, MODDEF_PHOTO_SD_CMD_TIMEOUT_MS);

	esp_err_t err = ensurePhotoSdMounted();
	if (err != ESP_OK && n < (int)sizeof(report)) {
		photoStorageFormatEspErr(err, g_photoStorageErrBuf, sizeof(g_photoStorageErrBuf));
		snprintf(report + n, sizeof(report) - (size_t)n, " mount_err=%s", g_photoStorageErrBuf);
	}

	xsResult = xsString(report);
	(void)the;
}

void xs_photo_storage_base64_encode(xsMachine *the)
{
	if (xsmcArgc < 1) {
		xsUnknownError("buffer required");
		return;
	}
	void *data = xsmcToArrayBuffer(xsArg(0));
	xsIntegerValue dataLen = xsmcGetArrayBufferLength(xsArg(0));

	const char *chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	xsIntegerValue outLen = ((dataLen + 2) / 3) * 4;
	char *out = (char *)malloc(outLen + 1);
	if (!out) {
		xsUnknownError("out of memory");
		return;
	}

	const uint8_t *src = (const uint8_t *)data;
	char *dst = out;
	xsIntegerValue i;
	for (i = 0; i < dataLen - 2; i += 3) {
		*dst++ = chars[src[i] >> 2];
		*dst++ = chars[((src[i] & 3) << 4) | (src[i+1] >> 4)];
		*dst++ = chars[((src[i+1] & 15) << 2) | (src[i+2] >> 6)];
		*dst++ = chars[src[i+2] & 63];
	}
	if (i < dataLen) {
		*dst++ = chars[src[i] >> 2];
		if (i + 1 < dataLen) {
			*dst++ = chars[((src[i] & 3) << 4) | (src[i+1] >> 4)];
			*dst++ = chars[(src[i+1] & 15) << 2];
		} else {
			*dst++ = chars[(src[i] & 3) << 4];
			*dst++ = '=';
		}
		*dst++ = '=';
	}
	*dst = '\0';

	xsResult = xsStringBuffer(out, (xsIntegerValue)(dst - out));
	free(out);
}

#ifndef xsID_Uint8Array
#define xsID_Uint8Array (xsID("Uint8Array"))
#endif

static uint32_t png_crc32(const uint8_t *data, int len) {
    uint32_t crc = 0xFFFFFFFF;
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return crc ^ 0xFFFFFFFF;
}

void xs_photo_storage_rgb565_to_png(xsMachine *the)
{
    if (xsmcArgc < 3) { xsUnknownError("args required"); return; }
    int width = xsmcToInteger(xsArg(0));
    int height = xsmcToInteger(xsArg(1));
    void *src = xsmcToArrayBuffer(xsArg(2));
    int pixelCount = width * height;

    // RGB565LE → RGB24
    uint8_t *rgb24 = (uint8_t *)malloc(pixelCount * 3);
    if (!rgb24) { xsUnknownError("oom rgb24"); return; }
    const uint16_t *src16 = (const uint16_t *)src;
    for (int i = 0; i < pixelCount; i++) {
        uint16_t px = src16[i];
        uint8_t r5 = (px >> 11) & 0x1F;
        uint8_t g6 = (px >> 5) & 0x3F;
        uint8_t b5 = px & 0x1F;
        rgb24[i*3+0] = (r5 << 3) | (r5 >> 2);
        rgb24[i*3+1] = (g6 << 2) | (g6 >> 4);
        rgb24[i*3+2] = (b5 << 3) | (b5 >> 2);
    }

    // Uncompressed PNG (deflate level 0)
    // Each row: 1 filter byte + width*3 bytes
    int rowSize = 1 + width * 3;
    // deflate store block: BFINAL|BTYPE, LEN, NLEN, data
    // multiple blocks if row > 65535 (won't happen here)
    int deflateSize = height * (5 + rowSize);
    // zlib header(2) + adler32(4)
    int zlibSize = 2 + deflateSize + 4;
    
    // PNG signature(8) + IHDR(25) + IDAT(12+zlibSize) + IEND(12)
    int pngSize = 8 + 25 + 12 + zlibSize + 12;
    uint8_t *png = (uint8_t *)malloc(pngSize);
    if (!png) { free(rgb24); xsUnknownError("oom png"); return; }

    uint8_t *p = png;
    
    // PNG signature
    static const uint8_t sig[8] = {137,80,78,71,13,10,26,10};
    memcpy(p, sig, 8); p += 8;
    
    // CRC32 helper (simple implementation)
    #define PNG_U32(b0,b1,b2,b3) (((uint32_t)(b0)<<24)|((uint32_t)(b1)<<16)|((uint32_t)(b2)<<8)|(b3))
    
    // IHDR chunk
    uint8_t ihdr[13];
    ihdr[0]=(width>>24)&0xFF; ihdr[1]=(width>>16)&0xFF; ihdr[2]=(width>>8)&0xFF; ihdr[3]=width&0xFF;
    ihdr[4]=(height>>24)&0xFF; ihdr[5]=(height>>16)&0xFF; ihdr[6]=(height>>8)&0xFF; ihdr[7]=height&0xFF;
    ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // 8bit RGB
    
    // Write chunk helper inline
    #define WRITE_U32(buf, v) do { (buf)[0]=((v)>>24)&0xFF; (buf)[1]=((v)>>16)&0xFF; (buf)[2]=((v)>>8)&0xFF; (buf)[3]=(v)&0xFF; } while(0)
    
    // IHDR
    WRITE_U32(p, 13); p += 4; // length
    memcpy(p, "IHDR", 4); 
    uint8_t *ihdr_type = p; p += 4;
    memcpy(p, ihdr, 13); p += 13;
    uint8_t ihdr_data[17]; memcpy(ihdr_data, "IHDR", 4); memcpy(ihdr_data+4, ihdr, 13);
    uint32_t crc = png_crc32(ihdr_data, 17);
    WRITE_U32(p, crc); p += 4;
    
    // IDAT
    WRITE_U32(p, zlibSize); p += 4;
    memcpy(p, "IDAT", 4); p += 4;
    uint8_t *idat_start = p;
    
    // zlib header: CMF=0x78 FLG=0x01
    *p++ = 0x78; *p++ = 0x01;
    
    // deflate uncompressed blocks per row
    uint32_t adler_s1 = 1, adler_s2 = 0;
    #define ADLER_MOD 65521
    #define ADLER_BYTE(b) do { adler_s1 = (adler_s1 + (b)) % ADLER_MOD; adler_s2 = (adler_s2 + adler_s1) % ADLER_MOD; } while(0)
    
    for (int row = 0; row < height; row++) {
        int isLast = (row == height - 1) ? 1 : 0;
        uint16_t len = (uint16_t)rowSize;
        uint16_t nlen = ~len;
        *p++ = isLast ? 0x01 : 0x00; // BFINAL|BTYPE=00
        *p++ = len & 0xFF; *p++ = (len >> 8) & 0xFF;
        *p++ = nlen & 0xFF; *p++ = (nlen >> 8) & 0xFF;
        // filter byte 0
        *p++ = 0x00; ADLER_BYTE(0x00);
        // RGB pixels
        for (int x = 0; x < width; x++) {
            uint8_t r = rgb24[(row*width+x)*3+0];
            uint8_t g = rgb24[(row*width+x)*3+1];
            uint8_t b = rgb24[(row*width+x)*3+2];
            *p++ = r; ADLER_BYTE(r);
            *p++ = g; ADLER_BYTE(g);
            *p++ = b; ADLER_BYTE(b);
        }
    }
    free(rgb24);
    
    // adler32
    uint32_t adler = (adler_s2 << 16) | adler_s1;
    WRITE_U32(p, adler); p += 4;
    
    // IDAT CRC
    int idat_len = (int)(p - idat_start);
    uint8_t idat_hdr[4]; memcpy(idat_hdr, "IDAT", 4);
    // CRC covers type+data
    uint8_t *idat_type_ptr = idat_start - 4;
    crc = png_crc32(idat_type_ptr, 4 + idat_len);
    WRITE_U32(p, crc); p += 4;
    
    // IEND
    WRITE_U32(p, 0); p += 4;
    memcpy(p, "IEND", 4); p += 4;
    uint8_t iend_crc_data[4]; memcpy(iend_crc_data, "IEND", 4);
    crc = png_crc32(iend_crc_data, 4);
    WRITE_U32(p, crc); p += 4;
    
    int actualSize = (int)(p - png);
    xsmcSetArrayBuffer(xsResult, png, actualSize);
    free(png);
    xsResult = xsNew1(xsGlobal, xsID_Uint8Array, xsResult);
}
