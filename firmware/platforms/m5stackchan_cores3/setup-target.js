import baseSetup from "m5stack-cores3/setup-target";
import { tracePhotoStorageBuildTag } from "photo-firmware-build-tag";

// Mirrors the CoreS3 power-rail setup used by M5Stack/StackChan firmware
// (`firmware/main/hal/board/stackchan.cc` near the AXP2101 init path) and the
// X-Powers AXP2101 register map for DCDC/ALDO/BLDO/LDO and charge-control fields.
function patchStackChanPower() {
	const axp2101 = globalThis.power?.axp2101;
	if (!axp2101) {
		trace("[m5stackchan] AXP2101 unavailable for power patch\n");
		return;
	}

	const data = axp2101.readByte(0x90);
	// Enable the LDO rails needed by the CoreS3 StackChan base.
	axp2101.writeByte(0x90, data | 0b10110100);
	// Set DCDC/LDO voltage selector used by the reference firmware.
	axp2101.writeByte(0x97, 0b11110 - 2);
	// Configure VBUS input current limit and power-path behavior.
	axp2101.writeByte(0x69, 0b00110101);
	// Enable required DCDC outputs.
	axp2101.writeByte(0x30, 0b111111);
	// Force the final LDO enable mask after the voltage selectors are set.
	axp2101.writeByte(0x90, 0xbf);
	// Set ALDO/BLDO voltage setpoints.
	axp2101.writeByte(0x94, 33 - 5);
	axp2101.writeByte(0x95, 33 - 5);
	// Disable one unused LDO path to match the reference board profile.
	axp2101.writeByte(0x27, 0x00);

	const charge = axp2101.readByte(0x62);
	// Preserve charge-control upper bits and set the target charge-current field.
	axp2101.writeByte(0x62, (charge & 0xe0) | 13);
	trace("[m5stackchan] patched CoreS3 AXP2101 power rails\n");
}

// import { runSdBootDiagnostics } from "photo-sd-boot";

export default function (done) {
	trace("[setup/target] startup (m5stackchan_cores3)\n");
	tracePhotoStorageBuildTag();
	baseSetup(() => {
		trace("[setup/target] after m5stack-cores3 baseSetup\n");
		trace(
			`[SD] setup compartment: Host.SdPower=${globalThis.Host?.SdPower ? "yes" : "no"} enable=${typeof globalThis.Host?.SdPower?.enable} readback=${typeof globalThis.traceCoreS3SdPowerReadback}\n`,
		);
		// runSdBootDiagnostics();
		done?.();
	});
}
