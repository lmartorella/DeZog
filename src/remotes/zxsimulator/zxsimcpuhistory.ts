import {CpuHistoryClass} from '../cpuhistory';
import {HistoryInstructionInfo} from '../decodehistinfo';
import {Settings} from '../../settings';
import {Z80Registers} from '../z80registers';
import {Utility} from '../../misc/utility';


/**
 * This class takes care of the internal simulator history.
 * Pleae note that for performance reasons (push if faster than unshift)
 * the history array has been turned around:
 * The oldest item is at 0, the youngest at historyIndex.
 * Please also note that the array is used as a ringbuffer once the
 * maximum size has reached (because of performance).
 * Variables:
 * - historyIndex: Read index (in ring buffer). Current position in history.
 * - historyWriteIndex: Write index (in ring buffer). Last written position.
 * - historyWriteLastIndex:
 *
 * If history-buffer <= maxSize:
 * |-----|------------| . . . . . . . . . . . . |
 * 0     h.Index      h.writeIndex=h.length-1   maxSize
 *
 * if history-buffer > maxSize:
 * |-----|------------|-------------------------|
 * 0     h.Index      h.writeIndex    h.length=maxSize
 */
export class ZxSimCpuHistory extends CpuHistoryClass {

	// The write index.
	protected historyWriteIndex: number;


	// Constructor
	constructor() {
		super();
	}


	/**
	 * Init.
	 */
	public init() {
		super.init();
		this.historyWriteIndex=-1;
	}


	/**
	 * The internal simulator (because it's internal) has a special way to store the history.
	 * So, clearing would be counter productive.
	 */
	public clear() {
		(async () => {
			this.historyIndex=-1;
			this.revDbgHistory.length=0;
			this.reverseDbgStack=undefined as any;
		})();
	}


	/**
	 * Retrieves the registers at the previous instruction from the Remote's cpu history.
	 * Is async.
	 * @returns Data with the registers or undefined if at the end of the history.
	 */
	public async getPrevRegistersAsync(): Promise<HistoryInstructionInfo|undefined> {
		let index=this.historyIndex;
		if (index<0) {
			// First step
			index=this.historyWriteIndex;
		}
		else {
			index--;
			if (index<0)
				index=this.history.length-1;
			if (index==this.historyWriteIndex)
				return undefined;
		}
		this.historyIndex=index;
		const regs=this.history[index];
		return regs;
	}


	/**
	 * Retrieves the registers at the next instruction.
	 * @returns Data with the registers or undefined if at the start of the history.
	 */
	public getNextRegisters(): HistoryInstructionInfo|undefined {
		let index=this.historyIndex;
		if (index==this.historyWriteIndex) {
			this.historyIndex=-1;
			return undefined;
		}
		index++;
		if (index>=this.history.length)
			index=0;
		this.historyIndex=index;
		const regs=this.history[index];
		return regs;
	}


	/**
	 * Pushes one history into the array.
	 * @param line One line of history.
	 * @param exchange true if the element should be exchanged rather than added.
	 * Note: If you use exchange=true you cannot call 'pushCallStack' afterwards.
	 */
	public pushHistoryInfo(line: HistoryInstructionInfo, exchange=false) {
		//Utility.assert(line);
		if (exchange&&this.history.length>0) {
			// Exchange
			this.history[this.historyWriteIndex]=line;
		}
		else {
			// Otherwise add, first check if max size is reached
			if (this.history.length>=this.maxSize) {
				let index=this.historyWriteIndex;
				index++;
				// Check for overflow
				if (index>=this.maxSize)
					index=0;
				this.historyWriteIndex=index;
				this.history[index]=line;
			}
			else {
				// Not yet reached, so grow the array
				this.history.push(line);
				this.historyWriteIndex++;
			}
		}
	}


	/**
	 * Returns the address of the i-th element before the current
	 * historyIndex.
	 * 0 = historyIndex.
	 * @param i The i-th element.
	 */
	public getPreviousAddress(i: number) {
		const len=this.history.length;
		if (len==0)
			return undefined;
		let k=this.historyIndex-i;
		if (k<0)
			k+=len;
		if (k==this.historyWriteIndex)
			return undefined;
		const line=this.history[k];
		const addr=this.getAddress(line);
		return addr;
	}


	/**
	 * Emits 'historySpot' to signal that the files should be decorated.
	 * It can happen that this method has to retrieve data from the
	 * remote.
	 */
	protected emitHistorySpot() {
		// Check if history spot is enabled
		let count=Settings.launch.history.spotCount;
		if (count<=0)
			return;

		// Otherwise calculate addresses
		const addresses=new Array<number>();

		// Before historyIndex
		const len=this.history.length;
		Utility.assert(len>0);
		let startIndex=this.historyIndex;	// historyIndex could be -1
		if (startIndex<0)
			startIndex=this.historyWriteIndex;
		let index=startIndex;
		for (let i=0; i<=count; i++) {
			const line=this.history[index];
			const pc=Z80Registers.decoder.parsePC(line);
			addresses.push(pc);
			index--;
			if (index<0)
				index=len-1;
			if (index==this.historyWriteIndex)
				break;
		}

		// After historyIndex
		index=startIndex;
		for (let i=0; i<count; i++) {
			if (index==this.historyWriteIndex)
				break;
			index++;
			if (index>=len)
				index=0;
			const line=this.history[index];
			const pc=Z80Registers.decoder.parsePC(line);
			addresses.unshift(pc);
		}
		let convertedStartIndex=index;

		// Emit code coverage event
		convertedStartIndex=this.historyWriteIndex-convertedStartIndex;
		if (convertedStartIndex<0)
			convertedStartIndex+=len;
		this.emit('historySpot', convertedStartIndex, addresses);
	}

}

