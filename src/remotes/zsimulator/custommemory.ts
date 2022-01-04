import { SimulatedMemory } from './simmemory';
import { MemoryBank, MemoryModel } from '../Paging/memorymodel';
import { ZSimCustomMemoryModel } from '../../settings';
import { Utility } from '../../misc/utility';

export class CustomMemory extends SimulatedMemory {
	constructor(memModel: ZSimCustomMemoryModel) {
		super(memModel.slotCount, memModel.bankCount);
		Utility.assert(memModel.slots.length === memModel.slotCount, "'slots' size should match 'slotCount'");

		// Propagate initial slot setup
		memModel.slots.forEach((bank, i) => {
			if (typeof bank === "number") {
				Utility.assert(bank >= 0 && bank < memModel.bankCount, `bank index ${bank} out of range`);
				this.setSlot(i, bank);
			} else {
				this.setAsNotPopulatedSlot(i);
			}
		});

		// Load ROMs
		(memModel.romBanks || []).forEach(rom => {
			Utility.assert(rom.bank >= 0 && rom.bank < memModel.bankCount, `bank index ${rom.bank} out of range`);
			this.readRomFileToBank(rom.file, rom.bank, rom.offset);
		});
	}

	public getMemoryModel(): MemoryModel {
		class CustomMemoryModel extends MemoryModel {
			constructor(private readonly owner: CustomMemory) {
				super(owner.slots.length);
			}

			public getMemoryBanks(slots: number[] | undefined): MemoryBank[] {
				slots = slots || this.owner.slots;
				const romCount = this.owner.romBanks.filter(b => b).length;
				const ramCount = this.owner.romBanks.length - romCount;
				return slots.map((bank, i) => {
					const start=i*this.bankSize;
					const end=start+this.bankSize-1;
					let name;
					if (!this.owner.populatedSlots[i]) {
						name = "N/A";
					} else if (this.owner.romBanks[bank]) {
						name = romCount > 1 ? `ROM${bank}` : "ROM";
					} else {
						name = ramCount > 1 ? `BANK${bank}` : "RAM";
					}
					return {start, end, name};
				});
			}
		}

		return new CustomMemoryModel(this);
	}
}

