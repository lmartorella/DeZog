import {SimulatedMemory} from './simmemory';
import {Utility} from '../../misc/utility';



/**
 * Represents the memory of a ZX 48k.
 * Especially sets the ROM area.
 */
export class Zx48Memory extends SimulatedMemory {

	/// Constructor.
	constructor() {
		super(4, 4);

		// 0000-0x3FFF is ROM
		const romFilePath = Utility.getExtensionPath() + '/data/48.rom';
		this.readRomFileToBank(romFilePath, 0);
	}
}

