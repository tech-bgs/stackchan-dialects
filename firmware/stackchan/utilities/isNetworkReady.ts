// @ts-nocheck
import ensureDefaultNetif from 'ensure-default-netif'
import Net from 'net'

export default function isNetworkReady(): boolean {
  const ip = Net.get('IP')
  if (typeof ip !== 'string' || ip.length === 0 || ip === '0.0.0.0') {
    return false
  }
  try {
    ensureDefaultNetif()
  } catch {
    return false
  }
  return true
}
