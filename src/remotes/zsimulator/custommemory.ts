import { SimulatedMemory } from './simmemory';
import { MemoryBank, MemoryModel } from '../Paging/memorymodel';
import { HexNumber, ZSimCustomMemoryModel, ZSimCustomMemorySlot } from '../../settings';
import { Utility } from '../../misc/utility';
import { Z80Ports } from './z80ports';

export class CustomMemory extends SimulatedMemory {
	private notPopulatedBank = -1;

	private toNumber(hex: HexNumber): number {
		if (typeof hex === "string") {
			if (/0x[0-9A-Fa-f]+/.test(hex) || /[0-9A-Fa-f]h+/.test(hex)) {
				return parseInt(hex, 16);
			} else {
				return parseInt(hex, 10);
			}
		} else {
			return hex;
		}
	}

	constructor(memModel: ZSimCustomMemoryModel, private readonly ports: Z80Ports) {
		super(1, 1);

		interface SlotInfo extends Omit<ZSimCustomMemorySlot, "range"> {
			begin: number;
			end: number;
			size: number;
			sizeInPages: number;
			populated?: boolean;
			bankCount: number;
			firstBank: number;
		}

		let slots: SlotInfo[] = memModel.map(slot => {
			const begin = this.toNumber(slot.range[0]);
			const end = this.toNumber(slot.range[1]);
			const size = end - begin + 1;
			return {
				rom: slot.rom,
				begin,
				end,
				size,
				populated: true,
				bankCount: slot.banked ? slot.banked.count : 1,
				banked: slot.banked,
				firstBank: -1,
				sizeInPages: -1
			};
		});

		// Check overlapping and fill the gaps
		slots = slots.reduce((list, slot, i) => {
			Utility.assert((slot.size % 1024) === 0, `Slot ${i} size not multiple of 1K`);
			list.push(slot);

			Utility.assert(slot.begin >= 0 && slot.end < 0x10000, "Slot out of 16-bit range");
			if (i > 0) {
				Utility.assert(slot.begin > slots[i - 1].end, `Slots ${i - 1} and ${i} are overlapping or out-of order`);
			}
			if (i < slots.length - 1) {
				Utility.assert(slot.end < slots[i + 1].begin, `Slots ${i} and ${i + 1} are overlapping or out-of order`);
				if (slot.end + 1 < slots[i + 1].begin) {
					// Fill unpopulated slot
					list.push({
						begin: slot.end + 1,
						end: slots[i + 1].begin - 1,
						populated: false,
						size: slots[i + 1].begin - slot.end - 1,
						bankCount: 1,
						sizeInPages: -1,
						firstBank: -1
					});
				}
			} else {
				if (slot.end < 0xffff) {
					// Fill unpopulated slot
					list.push({
						begin: slot.end + 1,
						end: 0xffff,
						populated: false,
						size: 0x10000 - slot.end - 1,
						sizeInPages: -1,
						bankCount: 1,
						firstBank: -1
					});
				}
			}
			return list;
		}, [] as SlotInfo[]);

		const slotSize = Math.min(...slots.map(slot => slot.size));
		slots.forEach(slot => {
			slot.sizeInPages = slot.size / slotSize;
			slot.bankCount *= slot.sizeInPages;
		});

		// Allocated non-populated bank
		let bankCount = 0;
		slots.forEach(slot => {
			if (slot.populated) {
				slot.firstBank = bankCount;
				bankCount += slot.bankCount;
			} else {
				if (this.notPopulatedBank < 0) {
					this.notPopulatedBank = bankCount;
					bankCount++;
				}
				slot.firstBank = this.notPopulatedBank;
			}
		});

		this.init(0x10000 / slotSize, bankCount);

		// Add a bank for the non-populated bank
		if (this.notPopulatedBank >= 0) {
			this.setAsNotPopulatedBank(this.notPopulatedBank);
		}

		slots.forEach(slot => {
			const firstSlot = slot.begin / slotSize;
			if (slot.rom) {
				for (let i = 0; i < slot.bankCount; i++) {
					this.readRomToBank(slot.rom, slot.firstBank + i, slotSize * i);
				}
			}

			const bankControl = slot.banked && slot.banked.control;
			if (bankControl) {
				const matcher = this.decodePortMask(bankControl.ioPort);
				this.ports.registerGenericOutPortFunction((port, value) => {
					if (matcher(port)) {
						const bank = this.decodeBankBits(value, bankControl.ioBitMap) * slot.sizeInPages;
						for (let i = 0; i < slot.sizeInPages; i++) {
							this.setSlot(firstSlot + i, slot.firstBank + bank + i);
						}
					}
				});
			}
		});
	}

	private decodeBankBits(byte: number, bitmap: number[]): number {
		let ret = 0;
		for (let b = 0, val = 1; b < bitmap.length; b++, val <<= 1) {
			const mask = 1 << bitmap[b];
			if (byte & mask) {
				ret += val;
			}
		}
		return ret;
	}

	private decodePortMask(port: HexNumber | { mask: HexNumber, match: HexNumber }): (port: number) => boolean {
		if (typeof port === "number" || typeof port === "string") {
			const match = this.toNumber(port);
			return port => match === port;
		} else {
			const mask = this.toNumber(port.mask);
			const match = this.toNumber(port.match);
			return port => (port & mask) === match;
		}
	}

	public getMemoryModel(): MemoryModel {
		class CustomMemoryModel extends MemoryModel {
			constructor(private readonly owner: CustomMemory) {
				super(owner.slots.length);
			}

			public getMemoryBanks(slots: number[] | undefined): MemoryBank[] {
				slots = slots || this.owner.slots;
				const romCount = this.owner.romBanks.filter((b, i) => b && i !== this.owner.notPopulatedBank).length;
				const ramCount = this.owner.romBanks.length - romCount;
				return slots.map((bank, i) => {
					const start=i*this.bankSize;
					const end=start+this.bankSize-1;
					let name: string;
					if (bank === this.owner.notPopulatedBank) {
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

