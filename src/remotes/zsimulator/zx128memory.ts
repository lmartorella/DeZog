import {Utility} from '../../misc/utility';
import {SimulatedMemory} from './simmemory';


/**
 * Represents the memory of a ZX 128k.
 * Especially sets the ROM area and
 * the initial slot/bank configuration.
 */
export class Zx128Memory extends SimulatedMemory {

	/// Constructor.
	constructor() {
		super(4, 10);
		// Bank 0-7 is RAM.
		// Bank configuration
		// Initially ROM 1 is selected
		this.slots = [9 /*ROM*/, 5, 2, 0];

		// 0000-0x3FFF is ROM. This is located in banks 8 and 9
		const romFilePath = Utility.getExtensionPath() + '/data/128.rom';
		this.readRomToBank(romFilePath, 8); /* 128 editor */
		this.readRomToBank(romFilePath, 9, this.bankSize); /* ZX 48K */
	}
}

