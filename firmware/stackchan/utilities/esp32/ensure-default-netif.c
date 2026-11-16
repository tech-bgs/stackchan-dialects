#include "xsPlatform.h"
#include "xs.h"
#include "esp_netif.h"

void xs_ensure_default_netif(xsMachine *the)
{
	esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
	if (netif == NULL)
		xsUnknownError("no wifi netif");

	if (esp_netif_get_default_netif() == netif)
		return;

	if (ESP_OK != esp_netif_set_default_netif(netif))
		xsUnknownError("set default netif failed");
}
