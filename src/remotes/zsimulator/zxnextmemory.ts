import {Utility} from '../../misc/utility';
import {SimulatedMemory} from './simmemory';


/**
 * Represents the memory of a ZX Next.
 * Especially sets the ROM area and
 * the initial slot/bank configuration.
 */
export class ZxNextMemory extends SimulatedMemory {

	/// Constructor.
	constructor() {
		super(8, 256);
		// ROM is located in banks 0xFE and 0xFF.
		// In real ZX Next both is mapped to 0xFF and distinguished by the slot.
		// Bank 0-253 are RAM.
		// Note: the real ZX Next does not offer so many RAM banks.
		// Bank configuration
		this.slots = [0xFE, 0xFF, 10, 11, 4, 5, 0, 1];
		// Load the  ROM
		const romFilePath = Utility.getExtensionPath() + '/data/48.rom';
		this.readRomFileToBank(romFilePath, 0xFE); /* first half */
		this.readRomFileToBank(romFilePath, 0xFF, this.bankSize); /* second half */
	}
}

