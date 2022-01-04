import {SimulatedMemory} from './simmemory';
import {Utility} from '../../misc/utility';

/**
 * Represents the memory of a ZX 16k.
 * Especially sets the ROM area.
 */
export class Zx16Memory extends SimulatedMemory {

	/// Constructor.
	constructor() {
		super(4, 2);

		// 0000-0x3FFF is ROM
		const romFilePath = Utility.getExtensionPath() + '/data/48.rom';
		this.readRomFileToBank(romFilePath, 0);

		// 8000-0xFFFF is not populated, read as 0xFF (floating bus)
		this.setAsNotPopulatedBank(2);
		this.setAsNotPopulatedBank(3);
	}
}

