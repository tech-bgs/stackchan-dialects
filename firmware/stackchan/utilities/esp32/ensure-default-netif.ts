// @ts-nocheck
export default function ensureDefaultNetif(): void {
  native('xs_ensure_default_netif').call(this)
}
