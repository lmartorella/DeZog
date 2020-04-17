import { ZesaruxExtRemote } from './zesarux/zesaruxextremote';
import { RemoteBase } from './remotebase';
import {ZxNextUsbSerialRemote} from './zxnext/zxnextusbserialremote';
import {ZxSimulatorRemote} from './zxsimulator/zxsimremote';
//import {ZxNextSocketRemote} from './zxnext/zxnextsocketremote';
import {CSpectRemote} from './zxnext/cspectremote';
import {Utility} from '../misc/utility';



/**
 * The factory creates a new remote.
 */
export class RemoteFactory {
	/**
	 * Factory method to create an emulator.
	 * @param remoteType 'zrcp', 'serial' or 'zsim'. For 'zrcp' always the ZesaruxExtEmulator is created.
	 * It will fallback to Zesarux if no ZesaruxExt is connected.
	 */
	public static createRemote(remoteType: string) {
		switch (remoteType) {
			case 'zrcp':	// ZEsarUX Remote Control Protocol
				RemoteFactory.setEmulator(new ZesaruxExtRemote());
				break;
			case 'cspect':	// CSpect socket
				RemoteFactory.setEmulator(new CSpectRemote());
				break;
			case 'serial':	// USB/serial connection
				RemoteFactory.setEmulator(new ZxNextUsbSerialRemote());
				break;
			case 'zsim':	// Simulator
				RemoteFactory.setEmulator(new ZxSimulatorRemote());
				break;
			case 'mame':
				Utility.assert(false);	// needs to be implemented
				break;
			default:
				Utility.assert(false);
				break;
		}
	}


	/**
	 * Sets the emulator variable.
	 */
	protected static setEmulator(emulator: RemoteBase) {
		Remote = emulator;
	}

}


export var Remote: RemoteBase;
