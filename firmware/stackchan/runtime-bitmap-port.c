#include "xs.h"
#include "piuMC.h"
#include "commodettoBitmap.h"
#include "commodettoPoco.h"
#include "commodettoBitmapFormat.h"
#include "xsmc.h"
#include "native/esp32/photo-display-flush-native.h"
#include <stdio.h>
#include <stdarg.h>

/* Grep in .o / xs_esp32s3.a / xs_esp32.bin — same string as fxReport ENTER format. */
static const char stackchan_photo_native_bin_marker[] __attribute__((used)) =
	"[PhotoNative] ENTER %s";

#define PHOTO_NATIVE_TRACE_MAX 48
#define PHOTO_FB_TRACE_MAX 32
static int stackchanPhotoNativeTraceCount;
static int stackchanPhotoFbTraceCount;

static void stackchanPhotoNativeEnter(xsMachine* the, const char* where)
{
	if (!the || stackchanPhotoNativeTraceCount >= PHOTO_NATIVE_TRACE_MAX)
		return;
	stackchanPhotoNativeTraceCount += 1;
	(void)stackchan_photo_native_bin_marker;
	fxReport(the, "[PhotoNative] ENTER %s\n", where);
}

static int stackchanRgb565LeLuma(uint8_t lo, uint8_t hi)
{
	int r5 = hi >> 3;
	int g6 = ((hi & 7) << 3) | (lo >> 5);
	int b5 = lo & 0x1F;
	int r = (r5 << 3) | (r5 >> 2);
	int g = (g6 << 2) | (g6 >> 4);
	int b = (b5 << 3) | (b5 >> 2);
	return (r * 77 + g * 150 + b * 29) >> 8;
}

static int stackchanSamplePocoRgb565Region(Poco poco, PocoCoordinate x, PocoCoordinate y, PocoDimension sw, PocoDimension sh, int* outMax)
{
	int stride;
	uint8_t* base = (uint8_t*)poco->pixels;

	/* During displayList build rowBytes is stale; never sample with stride 0 (walks into displayList). */
	if (poco->flags & (1 << 6)) {
		stride = ((int)poco->w * 16 + 7) >> 3;
		if (stride <= 0)
			stride = ((int)poco->width * 16 + 7) >> 3;
	}
	else {
		stride = (int)poco->rowBytes;
		if (stride <= 0)
			stride = ((int)poco->width * 16 + 7) >> 3;
	}
	int sum = 0;
	int samples = 0;
	int maxLuma = 0;
	int x0 = (int)x;
	int y0 = (int)y;
	int x1 = x0 + (int)sw;
	int y1 = y0 + (int)sh;
	int mx;
	int my;

	if (!base || stride <= 0 || sw == 0 || sh == 0)
		return -1;

	x0 += (int)sw / 4;
	y0 += (int)sh / 4;
	x1 -= (int)sw / 4;
	y1 -= (int)sh / 4;
	if (x1 <= x0)
		x1 = x0 + 1;
	if (y1 <= y0)
		y1 = y0 + 1;

	for (my = y0; my < y1; my += 8) {
		for (mx = x0; mx < x1; mx += 8) {
			int off;
			uint8_t lo;
			uint8_t hi;
			int luma;

			if (mx < 0 || my < 0 || mx >= (int)poco->width || my >= (int)poco->height)
				continue;
			off = my * stride + mx * 2;
			lo = base[off];
			hi = base[off + 1];
			luma = stackchanRgb565LeLuma(lo, hi);
			sum += luma;
			samples += 1;
			if (luma > maxLuma)
				maxLuma = luma;
		}
	}
	if (outMax)
		*outMax = maxLuma;
	return samples > 0 ? (sum / samples) : -1;
}

static void stackchanPhotoFbLogAfterBlit(xsMachine* the, Poco poco, PocoCoordinate x, PocoCoordinate y, PocoDimension srcW, PocoDimension srcH)
{
	int maxLuma = 0;
	int meanLuma;

	if (!the || stackchanPhotoFbTraceCount >= PHOTO_FB_TRACE_MAX)
		return;
	meanLuma = stackchanSamplePocoRgb565Region(poco, x, y, srcW, srcH, &maxLuma);
	stackchanPhotoFbTraceCount += 1;
	fxReport(
		the,
		"[PhotoFb] after BlitCore xy=%d,%d src=%ux%u poco=%ux%u stride=%d meanLuma=%d maxLuma=%d (displayList only; PocoDrawingEnd renders to SPI)\n",
		(int)x, (int)y, (unsigned)srcW, (unsigned)srcH,
		(unsigned)poco->width, (unsigned)poco->height, (int)poco->rowBytes,
		meanLuma, maxLuma
	);
}

static int stackchanRuntimeBitmapPortBlitCore(PiuPort* self, PiuView* view, PiuCoordinate x, PiuCoordinate y, PiuDimension sw, PiuDimension sh, xsMachine* the)
{
	Poco poco = (*view)->poco;
	CommodettoBitmap cb;
	PocoBitmapRecord bits;
	void* data = NULL;
	xsUnsignedValue dataSize;
	int drew = 0;
	(void)sw;
	(void)sh;

	stackchanPhotoNativeEnter(the, "BlitCore");

	if (!(poco->flags & (1 << 6))) {
		stackchanPhotoNativeEnter(the, "BlitCore no-didBegin");
		return 0;
	}

	xsmcVars(7);
	xsVar(0) = xsReference((*self)->reference);
	xsmcGet(xsVar(1), xsVar(0), xsID("_runtimeBitmap"));
	xsmcGet(xsVar(2), xsVar(0), xsID("_runtimeBitmapSX"));
	xsmcGet(xsVar(3), xsVar(0), xsID("_runtimeBitmapSY"));
	xsmcGet(xsVar(4), xsVar(0), xsID("_runtimeBitmapSW"));
	xsmcGet(xsVar(5), xsVar(0), xsID("_runtimeBitmapSH"));

	cb = xsmcGetHostChunk(xsVar(1));
	bits.width = cb->w;
	bits.height = cb->h;
	bits.format = cb->format;
#if COMMODETTO_BITMAP_ID
	bits.id = cb->id;
	bits.byteLength = cb->byteLength;
#endif
	if (cb->havePointer) {
		bits.pixels = cb->bits.data;
	}
	else {
		xsmcGet(xsVar(6), xsVar(1), xsID_buffer);
		xsmcGetBufferReadable(xsVar(6), &data, &dataSize);
		PocoDisableGC(poco);
		bits.pixels = (PocoPixel*)(cb->bits.offset + (char*)data);
	}

	{
		PocoDimension srcW = (PocoDimension)xsmcToInteger(xsVar(4));
		PocoDimension srcH = (PocoDimension)xsmcToInteger(xsVar(5));
		if ((bits.format == kCommodettoBitmapRGB565LE || bits.format == kCommodettoBitmapFormat) && srcW <= bits.width && srcH <= bits.height && srcW != 0 && srcH != 0) {
			PocoBitmapDraw(
				poco,
				&bits,
				x,
				y,
				(PocoDimension)xsmcToInteger(xsVar(2)),
				(PocoDimension)xsmcToInteger(xsVar(3)),
				srcW,
				srcH
			);
			stackchanPhotoFbLogAfterBlit(the, poco, x, y, srcW, srcH);
			drew = 1;
		}
	}
	return drew;
}

void xs_stackchan_runtime_bitmap_port_sample_poco_fb(xsMachine* the)
{
	PiuPort* self = PIU(Port, xsThis);
	PiuView* view = (*self)->view;
	PocoCoordinate x = (PocoCoordinate)xsmcToInteger(xsArg(0));
	PocoCoordinate y = (PocoCoordinate)xsmcToInteger(xsArg(1));
	PocoDimension sw = (PocoDimension)xsmcToInteger(xsArg(2));
	PocoDimension sh = (PocoDimension)xsmcToInteger(xsArg(3));
	int maxLuma = 0;
	int meanLuma = -1;

	if (view) {
		Poco poco = (*view)->poco;
		meanLuma = stackchanSamplePocoRgb565Region(poco, x, y, sw, sh, &maxLuma);
	}
	xsmcSetInteger(xsResult, meanLuma);
}

static int stackchanRuntimeBitmapPortBlit(PiuPort* self, PiuView* view, PiuCoordinate x, PiuCoordinate y, PiuDimension sw, PiuDimension sh)
{
	xsMachine* the = (*view)->the;
	int drew;

	xsBeginHost(the);
	stackchanPhotoNativeEnter(the, "Blit");
	drew = stackchanRuntimeBitmapPortBlitCore(self, view, x, y, sw, sh, the);
	xsEndHost(the);
	return drew;
}

static void stackchanRuntimeBitmapPortDrawAux(void* it, PiuView* view, PiuCoordinate x, PiuCoordinate y, PiuDimension sw, PiuDimension sh)
{
	xsMachine* the = (*view)->the;

	if (the) {
		xsBeginHost(the);
		stackchanPhotoNativeEnter(the, "DrawAux");
		xsEndHost(the);
	}
	stackchanRuntimeBitmapPortBlit((PiuPort*)it, view, x, y, sw, sh);
}

void xs_stackchan_scale_rgb565_le_2x(xsMachine* the)
{
	xsSlot srcSlot;
	void* src;
	xsUnsignedValue srcLength;
	uint8_t* srcCopy = NULL;
	int width;
	int height;
	int targetWidth;
	int targetHeight;
	xsUnsignedValue targetLength;
	uint8_t* dstBytes;
	xsIntegerValue y;
	xsIntegerValue x;

	if (xsmcArgc >= 3) {
		srcSlot = xsArg(0);
		width = xsmcToInteger(xsArg(1));
		height = xsmcToInteger(xsArg(2));
	}
	else if (xsmcArgc >= 2) {
		srcSlot = xsThis;
		width = xsmcToInteger(xsArg(0));
		height = xsmcToInteger(xsArg(1));
	}
	else
		xsRangeError("invalid args");

	if (width <= 0 || height <= 0)
		xsRangeError("invalid dimensions");

	targetWidth = width * 2;
	targetHeight = height * 2;
	targetLength = (xsUnsignedValue)(targetWidth * targetHeight * 2);

	xsmcVars(2);
	xsVar(0) = srcSlot;
	if (xsBufferRelocatable == xsmcGetBufferReadable(xsVar(0), &src, &srcLength)) {
		srcCopy = (uint8_t*)c_malloc(srcLength);
		if (srcCopy == NULL)
			xsUnknownError("no memory");
		xsmcGetArrayBufferData(xsVar(0), 0, srcCopy, (xsIntegerValue)srcLength);
		src = srcCopy;
	}
	if (srcLength < (xsUnsignedValue)(width * height * 2))
		xsRangeError("buffer too small");

	xsmcSetArrayBuffer(xsResult, NULL, targetLength);
	xsVar(1) = xsResult;
	xsmcGetBufferWritable(xsVar(1), (void**)&dstBytes, &targetLength);

	{
		uint8_t* srcBytes = (uint8_t*)src;
		int targetStride = targetWidth * 2;

		for (y = 0; y < height; y++) {
			int srcRow = y * width * 2;
			int dstRow0 = y * 2 * targetStride;
			int dstRow1 = dstRow0 + targetStride;
			for (x = 0; x < width; x++) {
				int srcOff = srcRow + x * 2;
				uint8_t lo = srcBytes[srcOff];
				uint8_t hi = srcBytes[srcOff + 1];
				int dstX = x * 2;
				int d0 = dstRow0 + dstX * 2;
				dstBytes[d0] = lo;
				dstBytes[d0 + 1] = hi;
				dstBytes[d0 + 2] = lo;
				dstBytes[d0 + 3] = hi;
				{
					int d2 = dstRow1 + dstX * 2;
					dstBytes[d2] = lo;
					dstBytes[d2 + 1] = hi;
					dstBytes[d2 + 2] = lo;
					dstBytes[d2 + 3] = hi;
				}
			}
		}
	}

	if (srcCopy != NULL)
		c_free(srcCopy);
}

void xs_stackchan_runtime_bitmap_port_draw(xsMachine* the)
{
	PiuPort* self = PIU(Port, xsThis);
	PiuView* view = (*self)->view;
	PiuCoordinate x, y;
	PiuDimension sw, sh;
	int drew = 0;

	stackchanPhotoNativeEnter(the, "port_draw");

	x = (PiuCoordinate)xsmcToInteger(xsArg(0));
	y = (PiuCoordinate)xsmcToInteger(xsArg(1));
	sw = (PiuDimension)xsmcToInteger(xsArg(4));
	sh = (PiuDimension)xsmcToInteger(xsArg(5));

	/* Port onDraw: fillColor is queued; bitmap must also go through DrawContent so list order is fill→bitmap (not bitmap→fill). */
	/* Immediate PocoBitmapDraw during onDraw ran before queued fill and could overflow displayList into clip stack. */
	if (view) {
		stackchanPhotoNativeEnter(the, "port_draw queue");
		PiuViewDrawContent(view, stackchanRuntimeBitmapPortDrawAux, self, x, y, sw, sh);
		drew = 1;
	}
	else if ((*self)->application && (*(*self)->application)->view) {
		stackchanPhotoNativeEnter(the, "port_draw defer");
		PiuViewDrawContent((*(*self)->application)->view, stackchanRuntimeBitmapPortDrawAux, self, x, y, sw, sh);
		drew = 1;
	}

	xsmcSetBoolean(xsResult, drew);
}

/* PocoDrawingEnd gDrawRenderCommand + ILI9341 doSend (grep PhotoPoco / PhotoFlush). */
static const char stackchan_photo_poco_bin_marker[] __attribute__((used)) =
	"[PhotoPoco] DL-STATE";
static const char stackchan_photo_frame_bin_marker[] __attribute__((used)) =
	"[PhotoFrame] onDraw#";
static const char stackchan_photo_fill_bin_marker[] __attribute__((used)) =
	"[PhotoFill]";

#define PHOTO_FILL_TRACE_MAX 64
static int stackchanPhotoFillTraceCount;
static const char stackchan_photo_flush_bin_marker[] __attribute__((used)) =
	"[PhotoFlush] ili.doSend#%d";

#define PHOTO_POCO_RENDER_LOG_MAX 64
#define PHOTO_FLUSH_ILI_LOG_MAX 48
#define kStackchanPocoCmdRectangleFill 0
#define kStackchanPocoCmdBitmapDraw 3
static int stackchanPhotoPocoRenderLogCount;
static int stackchanPhotoPocoBitmapDrawCount;
static int stackchanPhotoPocoBitmapSrcLogCount;
static int stackchanPhotoPocoBitmapEnterLogCount;
static int stackchanPhotoPocoBitmapSkipLogCount;
static int stackchanPhotoPocoBitmapBuildLogCount;
static int stackchanPhotoPocoListSnapLogCount;
static int stackchanPhotoPocoDrawingEndListLogCount;
static int stackchanPhotoDlBuildSeq;
static int stackchanPhotoDlBeginSeq;
static int stackchanPhotoDlEndSeq;
static int stackchanPhotoLastBuildSeq;
static int stackchanPhotoLastEndSeq;
static int stackchanPhotoOnDrawFrame;
static void* stackchanPhotoLastBuildPoco;
static void* stackchanPhotoLastBuildPc;
static void* stackchanPhotoLastBuildNext;
static int stackchanPhotoLastBuildUsed;
static int stackchanPhotoLastBuildCmd;
static int stackchanPhotoFlushArmed;
static xsMachine* stackchanPhotoFlushThe;
static int stackchanPhotoFlushIliBeginCount;
static int stackchanPhotoFlushIliDoSendCount;
static int stackchanPhotoFlushIliDoSendBytes;
static int stackchanPhotoFlushIliLogCount;
static int stackchanPhotoFlushLastBeginX;
static int stackchanPhotoFlushLastBeginY;
static int stackchanPhotoFlushLastBeginW;
static int stackchanPhotoFlushLastBeginH;
static int stackchanPhotoFlushFirstSendMeanLuma = -1;
static int stackchanPhotoFlushLastSendMeanLuma = -1;
static int stackchanPhotoFlushMaxSendMeanLuma = -1;
static int stackchanPhotoFlushBlitRowSendMeanLuma = -1;
static int stackchanPhotoFlushBlitX;
static int stackchanPhotoFlushBlitY;
static int stackchanPhotoFlushBlitW;
static int stackchanPhotoFlushBlitH;
static int stackchanPhotoFlushRowBytes;

static int stackchanSampleRgb565LeBufferMeanLuma(const uint8_t* base, int byteLength)
{
	int samples = 0;
	int sum = 0;
	int i;
	int maxSamples = 64;
	int step;

	if (!base || byteLength < 2)
		return -1;
	step = byteLength / (maxSamples * 2);
	if (step < 2)
		step = 2;
	for (i = 0; i + 1 < byteLength && samples < maxSamples; i += step) {
		int luma = stackchanRgb565LeLuma(base[i], base[i + 1]);
		sum += luma;
		samples += 1;
	}
	return samples > 0 ? (sum / samples) : -1;
}

static int stackchanSampleRgb565DstMean(const uint8_t* dst, int rowBytes, int w, int h)
{
	int samples = 0;
	int sum = 0;
	int y;
	int x;

	if (!dst || rowBytes < 2 || w <= 0 || h <= 0)
		return -1;
	for (y = 0; y < h; y += 4) {
		const uint8_t* row = dst + y * rowBytes;
		for (x = 0; x < w; x += 4) {
			int off = x * 2;
			if (off + 1 >= rowBytes)
				break;
			sum += stackchanRgb565LeLuma(row[off], row[off + 1]);
			samples += 1;
		}
	}
	return samples > 0 ? (sum / samples) : -1;
}

static const char* stackchanPocoCommandName(int command)
{
	switch (command) {
		case 0: return "RectangleFill";
		case 1: return "RectangleBlend";
		case 2: return "PixelDraw";
		case 3: return "BitmapDraw";
		case 4: return "MonochromeBitmapDraw";
		case 9: return "BitmapDrawMasked";
		case 12: return "External";
		default: return "Other";
	}
}

static int stackchanSampleRgb565LeRowAtX(const uint8_t* row, int rowByteLength, int x, int sw)
{
	int samples = 0;
	int sum = 0;
	int i;
	int x0 = x * 2;
	int x1 = x0 + sw * 2;

	if (!row || rowByteLength < 2 || sw <= 0)
		return -1;
	if (x1 > rowByteLength)
		x1 = rowByteLength;
	for (i = x0; i + 1 < x1; i += 8) {
		sum += stackchanRgb565LeLuma(row[i], row[i + 1]);
		samples += 1;
	}
	return samples > 0 ? (sum / samples) : -1;
}

static void stackchanPhotoFlushNoteSendLuma(int meanLuma, int rowY, int blitRowLuma)
{
	if (meanLuma < 0)
		return;
	stackchanPhotoFlushLastSendMeanLuma = meanLuma;
	if (stackchanPhotoFlushFirstSendMeanLuma < 0)
		stackchanPhotoFlushFirstSendMeanLuma = meanLuma;
	if (meanLuma > stackchanPhotoFlushMaxSendMeanLuma)
		stackchanPhotoFlushMaxSendMeanLuma = meanLuma;
	if (blitRowLuma >= 0)
		stackchanPhotoFlushBlitRowSendMeanLuma = blitRowLuma;
}

void stackchanPhotoFlushArm(int armed, void* theMachine)
{
	stackchanPhotoFlushArmed = armed ? 1 : 0;
	stackchanPhotoFlushThe = (xsMachine*)theMachine;
	if (!armed) {
		stackchanPhotoFlushIliBeginCount = 0;
		stackchanPhotoFlushIliDoSendCount = 0;
		stackchanPhotoFlushIliDoSendBytes = 0;
		stackchanPhotoFlushIliLogCount = 0;
		stackchanPhotoFlushFirstSendMeanLuma = -1;
		stackchanPhotoFlushLastSendMeanLuma = -1;
		stackchanPhotoFlushMaxSendMeanLuma = -1;
		stackchanPhotoFlushBlitRowSendMeanLuma = -1;
		stackchanPhotoFlushBlitX = 0;
		stackchanPhotoFlushBlitY = 0;
		stackchanPhotoFlushBlitW = 0;
		stackchanPhotoFlushBlitH = 0;
		stackchanPhotoFlushRowBytes = 0;
		stackchanPhotoPocoRenderLogCount = 0;
		stackchanPhotoPocoBitmapDrawCount = 0;
		stackchanPhotoPocoBitmapSrcLogCount = 0;
		stackchanPhotoPocoBitmapEnterLogCount = 0;
		stackchanPhotoPocoBitmapSkipLogCount = 0;
		stackchanPhotoPocoBitmapBuildLogCount = 0;
		stackchanPhotoPocoListSnapLogCount = 0;
		stackchanPhotoPocoDrawingEndListLogCount = 0;
		stackchanPhotoDlBuildSeq = 0;
		stackchanPhotoDlBeginSeq = 0;
		stackchanPhotoDlEndSeq = 0;
		stackchanPhotoLastBuildSeq = 0;
		stackchanPhotoLastEndSeq = 0;
		stackchanPhotoLastBuildPoco = NULL;
		stackchanPhotoLastBuildPc = NULL;
		stackchanPhotoLastBuildNext = NULL;
		stackchanPhotoLastBuildUsed = 0;
		stackchanPhotoLastBuildCmd = -1;
		stackchanPhotoOnDrawFrame = 0;
		stackchanPhotoFillTraceCount = 0;
	}
}

static void stackchanPhotoFillReport(Poco poco, const char* fmt, ...)
{
	va_list args;
	xsMachine* the = stackchanPhotoFlushThe;

	va_start(args, fmt);
	if (the) {
		char buf[256];
		vsnprintf(buf, sizeof(buf), fmt, args);
		fxReport(the, "%s\n", buf);
	}
	else {
		vprintf(fmt, args);
		printf("\n");
	}
	va_end(args);
	(void)poco;
}

void stackchanPhotoPocoRectangleFillTrace(void* pocoRef, const char* phase, int inX, int inY, int inW, int inH, int clipX, int clipY, int clipW, int clipH, void* pcRef, int pcH)
{
	Poco poco = (Poco)pocoRef;
	uint8_t* raw = (uint8_t*)pcRef;
	int suspicious = 0;
	int logAll = 0;

	if (!poco || !phase)
		return;
	if (clipH > (int)poco->height + 4 || clipW > (int)poco->width + 4 || pcH > (int)poco->height + 4)
		suspicious = 1;
	if (stackchanPhotoFillTraceCount < 12)
		logAll = 1;
	if (!suspicious && !logAll)
		return;
	if (stackchanPhotoFillTraceCount >= PHOTO_FILL_TRACE_MAX)
		return;
	stackchanPhotoFillTraceCount += 1;
	(void)stackchan_photo_fill_bin_marker;

	stackchanPhotoFillReport(
		poco,
		"[PhotoFill] %s poco=%p pc=%p onDrawFrame=%d pocoSize=%dx%d dirty=%d,%d+%dx%d yMax=%d\n",
		phase, (void*)poco, pcRef, stackchanPhotoOnDrawFrame,
		(int)poco->width, (int)poco->height,
		(int)poco->x, (int)poco->y, (int)poco->w, (int)poco->h, (int)poco->yMax
	);
	stackchanPhotoFillReport(
		poco,
		"[PhotoFill] %s in=%d,%d+%dx%d clip=%d,%d+%dx%d pcH=%d clipH=%d\n",
		phase, inX, inY, inW, inH, clipX, clipY, clipW, clipH, pcH, clipH
	);
	if (raw) {
		stackchanPhotoFillReport(
			poco,
			"[PhotoFill] %s raw@pc cmd=%u len=%u xywh=%d,%d+%dx%d bytes=%02x%02x %02x%02x %02x%02x %02x%02x %02x%02x\n",
			phase,
			(unsigned)raw[0], (unsigned)raw[1],
			(int)(int16_t)(raw[2] | (raw[3] << 8)),
			(int)(int16_t)(raw[4] | (raw[5] << 8)),
			(int)(int16_t)(raw[6] | (raw[7] << 8)),
			(int)(int16_t)(raw[8] | (raw[9] << 8)),
			raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7], raw[8], raw[9]
		);
	}
	if (suspicious) {
		stackchanPhotoFillReport(
			poco,
			"[PhotoFill] BAD-H phase=%s inH=%d clipH=%d pcH=%d (3869-class: check inH vs dirty yMax=%d or uninit pc->h)\n",
			phase, inH, clipH, pcH, (int)poco->yMax
		);
	}
}

void stackchanPhotoPocoDrawingBeginDirtyTrace(void* pocoRef, int x, int y, int w, int h)
{
	Poco poco = (Poco)pocoRef;

	if (!poco)
		return;
	if (h <= (int)poco->height + 4 && w <= (int)poco->width + 4)
		return;
	if (stackchanPhotoFillTraceCount >= PHOTO_FILL_TRACE_MAX)
		return;
	stackchanPhotoFillTraceCount += 1;
	stackchanPhotoFillReport(
		poco,
		"[PhotoFill] DrawingBegin dirty=%d,%d+%dx%d pocoSize=%dx%d yMax=%d onDrawFrame=%d\n",
		x, y, w, h, (int)poco->width, (int)poco->height, y + h, stackchanPhotoOnDrawFrame
	);
}

void stackchanPhotoSetOnDrawFrame(int frame)
{
	stackchanPhotoOnDrawFrame = frame;
}

void stackchanPhotoPocoBitmapDrawEnter(void* pocoRef, int bitsFormat, int expectFormat, int bitW, int bitH, int x, int y, int sx, int sy, int sw, int sh)
{
	Poco poco = (Poco)pocoRef;

	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe)
		return;
	if (stackchanPhotoPocoBitmapEnterLogCount >= 16)
		return;
	stackchanPhotoPocoBitmapEnterLogCount += 1;
	(void)stackchan_photo_poco_bin_marker;
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] PocoBitmapDraw ENTER fmt=%d expect=%d bmp=%dx%d at=%d,%d src=%d,%d+%dx%d clip=%d,%d+%dx%d\n",
		bitsFormat, expectFormat, bitW, bitH, x, y, sx, sy, sw, sh,
		poco ? (int)poco->x : -1, poco ? (int)poco->y : -1,
		poco ? (int)poco->w : -1, poco ? (int)poco->h : -1
	);
}

void stackchanPhotoPocoBitmapDrawSkip(const char* reason)
{
	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe || !reason)
		return;
	if (stackchanPhotoPocoBitmapSkipLogCount >= 24)
		return;
	stackchanPhotoPocoBitmapSkipLogCount += 1;
	fxReport(stackchanPhotoFlushThe, "[PhotoPoco] PocoBitmapDraw SKIP %s\n", reason);
}

void stackchanPhotoPocoBitmapDrawBuild(void* pocoRef, int x, int y, int w, int h)
{
	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe)
		return;
	if (stackchanPhotoPocoBitmapBuildLogCount >= 16)
		return;
	stackchanPhotoPocoBitmapBuildLogCount += 1;
	stackchanPhotoPocoBitmapDrawCount += 1;
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] BUILD BitmapDraw command xy=%d,%d wh=%dx%d built=%d\n",
		x, y, w, h, stackchanPhotoPocoBitmapBuildLogCount
	);
}

typedef struct {
	uint8_t command;
	uint8_t length;
	int16_t x;
	int16_t y;
	int16_t w;
	int16_t h;
} StackchanPocoCommandHeader;

static StackchanPocoCommandHeader* stackchanPocoCommandAt(char* base, StackchanPocoCommandHeader* end)
{
	if (!base || !end || (char*)end <= base)
		return NULL;
	return (StackchanPocoCommandHeader*)base;
}

static StackchanPocoCommandHeader* stackchanPocoCommandNext(StackchanPocoCommandHeader* cmd, StackchanPocoCommandHeader* end)
{
	char* next;

	if (!cmd || cmd >= end)
		return NULL;
	next = (char*)cmd + cmd->length;
	if (next >= (char*)end)
		return NULL;
	return (StackchanPocoCommandHeader*)next;
}

void stackchanPhotoPocoDrawingEndFillVerify(void* pocoRef)
{
	Poco poco = (Poco)pocoRef;
	StackchanPocoCommandHeader* end;
	StackchanPocoCommandHeader* walker;

	if (!poco || !poco->displayList || !poco->next)
		return;
	end = (StackchanPocoCommandHeader*)poco->next;
	if (end == (StackchanPocoCommandHeader*)poco->displayList)
		return;
	walker = stackchanPocoCommandAt(poco->displayList, end);
	if (!walker || walker->command != kStackchanPocoCmdRectangleFill)
		return;
	if (walker->h <= (int)poco->height + 4 && stackchanPhotoFillTraceCount >= 12)
		return;
	if (stackchanPhotoFillTraceCount >= PHOTO_FILL_TRACE_MAX)
		return;
	stackchanPhotoFillTraceCount += 1;
	stackchanPhotoFillReport(
		poco,
		"[PhotoFill] at-DrawingEnd displayList[0] RectangleFill xy=%d,%d wh=%dx%d pocoSize=%dx%d dirty=%d,%d+%dx%d yMax=%d onDrawFrame=%d\n",
		(int)walker->x, (int)walker->y, (int)walker->w, (int)walker->h,
		(int)poco->width, (int)poco->height,
		(int)poco->x, (int)poco->y, (int)poco->w, (int)poco->h, (int)poco->yMax,
		stackchanPhotoOnDrawFrame
	);
}

static int stackchanPhotoTagEquals(const char* tag, const char* want)
{
	const char* a = tag;
	const char* b = want;

	if (!a || !b)
		return 0;
	while (*b) {
		if (*a++ != *b++)
			return 0;
	}
	return *a == 0;
}

static void stackchanPocoCountDisplayList(Poco poco, int* outTotal, int* outBitmap, int* outFill)
{
	StackchanPocoCommandHeader* end;
	StackchanPocoCommandHeader* walker;
	int total = 0;
	int bitmapN = 0;
	int fillN = 0;

	if (outTotal)
		*outTotal = 0;
	if (outBitmap)
		*outBitmap = 0;
	if (outFill)
		*outFill = 0;
	if (!poco || !poco->displayList)
		return;
	end = (StackchanPocoCommandHeader*)poco->next;
	if (end == (StackchanPocoCommandHeader*)poco->displayList)
		return;
	for (walker = stackchanPocoCommandAt(poco->displayList, end); walker; walker = stackchanPocoCommandNext(walker, end)) {
		total += 1;
		if (walker->command == kStackchanPocoCmdBitmapDraw)
			bitmapN += 1;
		else if (walker->command == kStackchanPocoCmdRectangleFill)
			fillN += 1;
	}
	if (outTotal)
		*outTotal = total;
	if (outBitmap)
		*outBitmap = bitmapN;
	if (outFill)
		*outFill = fillN;
}

void stackchanPhotoPocoDisplayListSnap(void* pocoRef, const char* tag, void* pcRef)
{
	Poco poco = (Poco)pocoRef;
	StackchanPocoCommandHeader* pc = (StackchanPocoCommandHeader*)pcRef;
	int displayListLength = 0;
	int displayListUsed = 0;
	int displayListAvailable = 0;
	int total = 0;
	int bitmapN = 0;
	int fillN = 0;
	int didBegin = 0;
	int pcCmd = -1;
	int pcLen = 0;
	int nextReset = 0;

	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe || !poco || !tag)
		return;
	if (stackchanPhotoPocoListSnapLogCount >= 48)
		return;
	stackchanPhotoPocoListSnapLogCount += 1;
	(void)stackchan_photo_poco_bin_marker;
	(void)stackchan_photo_frame_bin_marker;

	if (poco->displayList && poco->displayListEnd)
		displayListLength = (int)(poco->displayListEnd - poco->displayList);
	if (poco->displayList && poco->next)
		displayListUsed = (int)((char*)poco->next - poco->displayList);
	if (poco->displayListEnd && poco->next)
		displayListAvailable = (int)(poco->displayListEnd - (char*)poco->next);
	if (poco->displayList && poco->next)
		nextReset = ((char*)poco->next == poco->displayList) ? 1 : 0;
	didBegin = (poco->flags & (1 << 6)) ? 1 : 0;
	stackchanPocoCountDisplayList(poco, &total, &bitmapN, &fillN);
	if (pc) {
		pcCmd = (int)pc->command;
		pcLen = (int)pc->length;
	}

	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] DL-STATE tag=%s onDrawFrame=%d buildSeq=%d beginSeq=%d endSeq=%d poco=%p pc=%p\n",
		tag, stackchanPhotoOnDrawFrame, stackchanPhotoDlBuildSeq, stackchanPhotoDlBeginSeq, stackchanPhotoDlEndSeq,
		(void*)poco, (void*)pc
	);
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] DL-STATE tag=%s displayList=%p next=%p displayListEnd=%p displayListLength=%d displayListUsed=%d displayListAvailable=%d nextReset=%d\n",
		tag, (void*)poco->displayList, (void*)poco->next, (void*)poco->displayListEnd,
		displayListLength, displayListUsed, displayListAvailable, nextReset
	);
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] DL-STATE tag=%s walk=%d bitmap=%d fill=%d didBegin=%d stack=%d flags=0x%x pcCmd=%d pcLen=%d\n",
		tag, total, bitmapN, fillN, didBegin, (int)poco->stackDepth, (unsigned)poco->flags, pcCmd, pcLen
	);

	if (stackchanPhotoTagEquals(tag, "after-PocoCommandBuilt")) {
		stackchanPhotoDlBuildSeq += 1;
		stackchanPhotoLastBuildSeq = stackchanPhotoDlBuildSeq;
		stackchanPhotoLastBuildPoco = (void*)poco;
		stackchanPhotoLastBuildPc = (void*)pc;
		stackchanPhotoLastBuildNext = (void*)poco->next;
		stackchanPhotoLastBuildUsed = displayListUsed;
		stackchanPhotoLastBuildCmd = pcCmd;
		if (pc && pcCmd == kStackchanPocoCmdBitmapDraw) {
			fxReport(
				stackchanPhotoFlushThe,
				"[PhotoPoco] DL-STATE tag=%s built BitmapDraw at pc=%p next=%p used=%d\n",
				tag, (void*)pc, (void*)poco->next, displayListUsed
			);
		}
	}
	else if (stackchanPhotoTagEquals(tag, "PocoDrawingBegin")) {
		stackchanPhotoDlBeginSeq += 1;
		if (stackchanPhotoLastBuildPoco == (void*)poco && stackchanPhotoLastEndSeq < stackchanPhotoLastBuildSeq) {
			fxReport(
				stackchanPhotoFlushThe,
				"[PhotoPoco] DL-VERDICT hypothesis=begin-reset poco=%p buildSeq=%d beginSeq=%d lastBuildUsed=%d lastBuildNext=%p nowNext=%p (PocoDrawingBegin sets next=displayList)\n",
				(void*)poco, stackchanPhotoLastBuildSeq, stackchanPhotoDlBeginSeq,
				stackchanPhotoLastBuildUsed, stackchanPhotoLastBuildNext, (void*)poco->next
			);
		}
		if (nextReset)
			fxReport(stackchanPhotoFlushThe, "[PhotoPoco] DL-VERDICT hypothesis=begin-reset confirmed next==displayList used=0\n");
	}
	else if (stackchanPhotoTagEquals(tag, "before-PocoDrawingEnd")) {
		stackchanPhotoDlEndSeq += 1;
		stackchanPhotoLastEndSeq = stackchanPhotoDlEndSeq;
		if (stackchanPhotoOnDrawFrame > 0 && stackchanPhotoOnDrawFrame <= 6) {
			fxReport(
				stackchanPhotoFlushThe,
				"[PhotoFrame] flush onDrawFrame=%d displayListUsed=%d walk=%d fill=%d bitmap=%d dirty=%d,%d+%dx%d\n",
				stackchanPhotoOnDrawFrame, displayListUsed, total, fillN, bitmapN,
				(int)poco->x, (int)poco->y, (int)poco->w, (int)poco->h
			);
		}

		if (stackchanPhotoLastBuildPoco && stackchanPhotoLastBuildPoco != (void*)poco) {
			fxReport(
				stackchanPhotoFlushThe,
				"[PhotoPoco] DL-VERDICT hypothesis=other-poco buildPoco=%p endPoco=%p buildSeq=%d endSeq=%d\n",
				stackchanPhotoLastBuildPoco, (void*)poco, stackchanPhotoLastBuildSeq, stackchanPhotoDlEndSeq
			);
		}
		else if (stackchanPhotoLastBuildPoco == (void*)poco) {
			if (stackchanPhotoLastBuildUsed > 0 && bitmapN == 0) {
				fxReport(
					stackchanPhotoFlushThe,
					"[PhotoPoco] DL-VERDICT hypothesis=begin-reset-or-overwrite samePoco=%p buildUsed=%d endUsed=%d buildPc=%p buildNext=%p endNext=%p walkBm=%d\n",
					(void*)poco, stackchanPhotoLastBuildUsed, displayListUsed,
					stackchanPhotoLastBuildPc, stackchanPhotoLastBuildNext, (void*)poco->next, bitmapN
				);
			}
			if (stackchanPhotoLastBuildPc && stackchanPhotoLastBuildCmd == kStackchanPocoCmdBitmapDraw) {
				StackchanPocoCommandHeader* atBuild = (StackchanPocoCommandHeader*)stackchanPhotoLastBuildPc;
				int inRange = 0;
				int nowCmd = -1;
				if (poco->displayList && poco->next
					&& (char*)stackchanPhotoLastBuildPc >= poco->displayList
					&& (char*)stackchanPhotoLastBuildPc < (char*)poco->next) {
					inRange = 1;
					nowCmd = (int)atBuild->command;
				}
				if (inRange && nowCmd != stackchanPhotoLastBuildCmd) {
					fxReport(
						stackchanPhotoFlushThe,
						"[PhotoPoco] DL-VERDICT hypothesis=overwrite buildPc=%p wasCmd=%d nowCmd=%d (bytes at BUILD slot changed)\n",
						stackchanPhotoLastBuildPc, stackchanPhotoLastBuildCmd, nowCmd
					);
				}
				else if (!inRange && stackchanPhotoLastBuildUsed > 0) {
					fxReport(
						stackchanPhotoFlushThe,
						"[PhotoPoco] DL-VERDICT hypothesis=begin-reset buildPc=%p outside [%p,%p) — next moved back or list cleared\n",
						stackchanPhotoLastBuildPc, (void*)poco->displayList, (void*)poco->next
					);
				}
			}
		}
	}
}

void stackchanPhotoPocoDrawingEndList(void* pocoRef)
{
	Poco poco = (Poco)pocoRef;
	StackchanPocoCommandHeader* end;
	StackchanPocoCommandHeader* walker;
	int total = 0;
	int bitmapN = 0;
	int fillN = 0;
	int i;

	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe || !poco)
		return;
	if (stackchanPhotoPocoDrawingEndListLogCount >= 8)
		return;
	end = (StackchanPocoCommandHeader*)poco->next;
	if (!poco->displayList || end == (StackchanPocoCommandHeader*)poco->displayList) {
		fxReport(stackchanPhotoFlushThe, "[PhotoPoco] PocoDrawingEnd displayList EMPTY\n");
		stackchanPhotoPocoDrawingEndListLogCount += 1;
		return;
	}
	for (walker = stackchanPocoCommandAt(poco->displayList, end); walker; walker = stackchanPocoCommandNext(walker, end)) {
		total += 1;
		if (walker->command == kStackchanPocoCmdBitmapDraw)
			bitmapN += 1;
		else if (walker->command == kStackchanPocoCmdRectangleFill)
			fillN += 1;
	}
	stackchanPhotoPocoDrawingEndListLogCount += 1;
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] PocoDrawingEnd displayList cmds=%d fill=%d bitmap=%d dirty=%d,%d+%dx%d\n",
		total, fillN, bitmapN, (int)poco->x, (int)poco->y, (int)poco->w, (int)poco->h
	);
	for (walker = stackchanPocoCommandAt(poco->displayList, end), i = 0; walker && i < 24; walker = stackchanPocoCommandNext(walker, end), i += 1) {
		fxReport(
			stackchanPhotoFlushThe,
			"[PhotoPoco] displayList[%d] cmd=%d %s xy=%d,%d wh=%dx%d\n",
			i, (int)walker->command, stackchanPocoCommandName((int)walker->command),
			(int)walker->x, (int)walker->y, (int)walker->w, (int)walker->h
		);
	}
}

void stackchanPhotoPocoBitmapSrc(void* pocoRef, void* srcPixels, int rowPixels, int w, int h)
{
	int srcMean;
	int rowBytes;

	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe || !srcPixels || w <= 0 || h <= 0)
		return;
	if (stackchanPhotoPocoBitmapSrcLogCount >= 4)
		return;
	stackchanPhotoPocoBitmapSrcLogCount += 1;
	rowBytes = rowPixels > 0 ? rowPixels * 2 : w * 2;
	srcMean = stackchanSampleRgb565DstMean((const uint8_t*)srcPixels, rowBytes, w, h);
	(void)stackchan_photo_poco_bin_marker;
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] BitmapSrc mean=%d rowPixels=%d wh=%dx%d (displayList src before c_memcpy)\n",
		srcMean, rowPixels, w, h
	);
}

void stackchanPhotoPocoRenderCommand(void* pocoRef, int command, int x, int y, int w, int h)
{
	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe)
		return;
	if (stackchanPhotoPocoRenderLogCount >= PHOTO_POCO_RENDER_LOG_MAX)
		return;
	stackchanPhotoPocoRenderLogCount += 1;
	if (command == kStackchanPocoCmdBitmapDraw || command == kStackchanPocoCmdRectangleFill
		|| stackchanPhotoPocoRenderLogCount <= 12) {
		(void)stackchan_photo_poco_bin_marker;
		fxReport(
			stackchanPhotoFlushThe,
			"[PhotoPoco] render cmd=%d %s xy=%d,%d wh=%dx%d #%d bitmapDraws=%d\n",
			command, stackchanPocoCommandName(command), x, y, w, h,
			stackchanPhotoPocoRenderLogCount, stackchanPhotoPocoBitmapDrawCount
		);
	}
}

void stackchanPhotoPocoAfterRender(void* pocoRef, int command, void* dst, int rowBytes, int drawW, int drawH, int slabX, int slabY)
{
	int meanLuma;
	int maxLuma = 0;
	int slabMean = -1;
	Poco poco = (Poco)pocoRef;

	if (!stackchanPhotoFlushArmed || !stackchanPhotoFlushThe || !dst)
		return;
	if (command != kStackchanPocoCmdBitmapDraw && command != kStackchanPocoCmdRectangleFill)
		return;
	if (stackchanPhotoPocoRenderLogCount >= PHOTO_POCO_RENDER_LOG_MAX)
		return;
	meanLuma = stackchanSampleRgb565DstMean((const uint8_t*)dst, rowBytes, drawW, drawH);
	if (poco)
		slabMean = stackchanSamplePocoRgb565Region(poco, (PocoCoordinate)slabX, (PocoCoordinate)slabY, (PocoDimension)drawW, (PocoDimension)drawH, &maxLuma);
	(void)stackchan_photo_poco_bin_marker;
	fxReport(
		stackchanPhotoFlushThe,
		"[PhotoPoco] after cmd=%d %s dstMean=%d slabMean=%d max=%d slab@%d,%d wh=%dx%d rowBytes=%d\n",
		command, stackchanPocoCommandName(command), meanLuma, slabMean, maxLuma,
		slabX, slabY, drawW, drawH, rowBytes
	);
}

void stackchanPhotoFlushSetBlitRect(int x, int y, int w, int h)
{
	stackchanPhotoFlushBlitX = x;
	stackchanPhotoFlushBlitY = y;
	stackchanPhotoFlushBlitW = w;
	stackchanPhotoFlushBlitH = h;
}

void stackchanPhotoFlushIli9341Begin(int x, int y, int w, int h)
{
	if (!stackchanPhotoFlushArmed)
		return;
	stackchanPhotoFlushIliBeginCount += 1;
	stackchanPhotoFlushLastBeginX = x;
	stackchanPhotoFlushLastBeginY = y;
	stackchanPhotoFlushLastBeginW = w;
	stackchanPhotoFlushLastBeginH = h;
	stackchanPhotoFlushFirstSendMeanLuma = -1;
	stackchanPhotoFlushLastSendMeanLuma = -1;
	stackchanPhotoFlushMaxSendMeanLuma = -1;
	stackchanPhotoFlushBlitRowSendMeanLuma = -1;
	stackchanPhotoFlushRowBytes = w > 0 ? w * 2 : 0;
	if (stackchanPhotoFlushThe && stackchanPhotoFlushIliLogCount < PHOTO_FLUSH_ILI_LOG_MAX) {
		stackchanPhotoFlushIliLogCount += 1;
		(void)stackchan_photo_flush_bin_marker;
		fxReport(
			stackchanPhotoFlushThe,
			"[PhotoFlush] ili.begin#%d xy=%d,%d wh=%dx%d\n",
			stackchanPhotoFlushIliBeginCount, x, y, w, h
		);
	}
}

void stackchanPhotoFlushIli9341DoSend(void* pixels, int byteLength)
{
	int nbytes;
	int meanLuma;
	int blitRowLuma = -1;
	int rowY = -1;
	const uint8_t* base = (const uint8_t*)pixels;

	if (!stackchanPhotoFlushArmed)
		return;
	nbytes = byteLength < 0 ? -byteLength : byteLength;
	meanLuma = stackchanSampleRgb565LeBufferMeanLuma(base, nbytes);
	if (stackchanPhotoFlushRowBytes > 0 && nbytes >= stackchanPhotoFlushRowBytes) {
		int rowsInChunk = nbytes / stackchanPhotoFlushRowBytes;
		int rowIndex;
		for (rowIndex = 0; rowIndex < rowsInChunk; rowIndex += 1) {
			const uint8_t* rowPtr = base + rowIndex * stackchanPhotoFlushRowBytes;
			int y = stackchanPhotoFlushLastBeginY
				+ (stackchanPhotoFlushIliDoSendBytes / stackchanPhotoFlushRowBytes) + rowIndex;
			int rowMean;
			if (stackchanPhotoFlushBlitH <= 0 || y < stackchanPhotoFlushBlitY
				|| y >= stackchanPhotoFlushBlitY + stackchanPhotoFlushBlitH)
				continue;
			rowMean = stackchanSampleRgb565LeRowAtX(
				rowPtr, stackchanPhotoFlushRowBytes, stackchanPhotoFlushBlitX, stackchanPhotoFlushBlitW);
			if (rowMean < 0)
				continue;
			if (blitRowLuma < 0 || rowMean > blitRowLuma) {
				blitRowLuma = rowMean;
				rowY = y;
			}
		}
	}
	stackchanPhotoFlushNoteSendLuma(meanLuma, rowY, blitRowLuma);
	stackchanPhotoFlushIliDoSendCount += 1;
	stackchanPhotoFlushIliDoSendBytes += nbytes;
	if (stackchanPhotoFlushThe && stackchanPhotoFlushIliLogCount < PHOTO_FLUSH_ILI_LOG_MAX && blitRowLuma >= 0) {
		stackchanPhotoFlushIliLogCount += 1;
		(void)stackchan_photo_flush_bin_marker;
		fxReport(
			stackchanPhotoFlushThe,
			"[PhotoFlush] ili.blitRow y=%d luma@%d=%d chunkHead=%d\n",
			rowY, stackchanPhotoFlushBlitX, blitRowLuma, meanLuma
		);
	}
}

int stackchanPhotoFlushIli9341GetBeginCount(void)
{
	return stackchanPhotoFlushIliBeginCount;
}

int stackchanPhotoFlushIli9341GetDoSendCount(void)
{
	return stackchanPhotoFlushIliDoSendCount;
}

int stackchanPhotoFlushIli9341GetDoSendBytes(void)
{
	return stackchanPhotoFlushIliDoSendBytes;
}

void xs_stackchan_photo_flush_arm(xsMachine* the)
{
	int armed = xsmcToBoolean(xsArg(0));
	stackchanPhotoFlushArm(armed, the);
	if (armed && xsmcArgc >= 5) {
		stackchanPhotoFlushSetBlitRect(
			xsmcToInteger(xsArg(1)),
			xsmcToInteger(xsArg(2)),
			xsmcToInteger(xsArg(3)),
			xsmcToInteger(xsArg(4))
		);
	}
	xsmcSetInteger(xsResult, armed);
}

void xs_stackchan_photo_set_on_draw_frame(xsMachine* the)
{
	stackchanPhotoSetOnDrawFrame(xsmcToInteger(xsArg(0)));
}

void xs_stackchan_photo_flush_get_stats(xsMachine* the)
{
	xsmcVars(11);
	xsmcSetInteger(xsVar(0), stackchanPhotoFlushIli9341GetBeginCount());
	xsmcSetInteger(xsVar(1), stackchanPhotoFlushIli9341GetDoSendCount());
	xsmcSetInteger(xsVar(2), stackchanPhotoFlushIli9341GetDoSendBytes());
	xsmcSetInteger(xsVar(3), stackchanPhotoFlushLastBeginX);
	xsmcSetInteger(xsVar(4), stackchanPhotoFlushLastBeginY);
	xsmcSetInteger(xsVar(5), stackchanPhotoFlushLastBeginW);
	xsmcSetInteger(xsVar(6), stackchanPhotoFlushLastBeginH);
	xsmcSetInteger(xsVar(7), stackchanPhotoFlushFirstSendMeanLuma);
	xsmcSetInteger(xsVar(8), stackchanPhotoFlushLastSendMeanLuma);
	xsmcSetInteger(xsVar(9), stackchanPhotoFlushMaxSendMeanLuma);
	xsmcSetInteger(xsVar(10), stackchanPhotoFlushBlitRowSendMeanLuma);
	xsmcSetNewObject(xsResult);
	xsmcSet(xsResult, xsID_begin, xsVar(0));
	xsmcSet(xsResult, xsID_send, xsVar(1));
	xsmcSet(xsResult, xsID_bytes, xsVar(2));
	xsmcSet(xsResult, xsID_x, xsVar(3));
	xsmcSet(xsResult, xsID_y, xsVar(4));
	xsmcSet(xsResult, xsID_width, xsVar(5));
	xsmcSet(xsResult, xsID_height, xsVar(6));
	xsmcSet(xsResult, xsID_value, xsVar(7));
	xsmcSet(xsResult, xsID_delta, xsVar(8));
	xsmcSet(xsResult, xsID_max, xsVar(9));
	xsmcSet(xsResult, xsID_min, xsVar(10));
}
