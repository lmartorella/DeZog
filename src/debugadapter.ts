import * as assert from 'assert';
import { basename } from 'path';
import * as vscode from 'vscode';
import { /*Handles,*/ Breakpoint /*, OutputEvent*/, DebugSession, InitializedEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, /*BreakpointEvent,*/ /*OutputEvent,*/ Thread, ContinuedEvent, CapabilitiesEvent } from 'vscode-debugadapter/lib/main';
import { DebugProtocol } from 'vscode-debugprotocol/lib/debugProtocol';
import { CallSerializer } from './callserializer';
import { Labels } from './labels';
import { Log, LogSocket } from './log';
import { RemoteBreakpoint, MachineType } from './remotes/remoteclass';
import { MemoryDumpView } from './views/memorydumpview';
import { MemoryRegisterView } from './views/memoryregisterview';
import { RefList } from './reflist';
import { Settings, SettingsParameters } from './settings';
import { /*ShallowVar,*/ DisassemblyVar, MemoryPagesVar, LabelVar, RegistersMainVar, RegistersSecondaryVar, StackVar } from './variables/shallowvar';
import { Utility } from './utility';
import { Z80RegisterHoverFormat, Z80RegisterVarFormat, Z80Registers } from './remotes/z80registers';
import { RemoteFactory, Remote } from './remotes/remotefactory';
import { StateZX16K } from './statez80';
import { ZxNextSpritesView } from './views/zxnextspritesview';
import { TextView } from './views/textview';
import { BaseView } from './views/baseview';
import { ZxNextSpritePatternsView } from './views/zxnextspritepatternsview';
import { Disassembler } from './disassembler/disasm';
import { MemAttribute } from './disassembler/memory';
import { Opcode, Opcodes } from './disassembler/opcode';
import {Decoration} from './decoration';
import {ShallowVar} from './variables/shallowvar';




/// State of the debug adapter.
enum DbgAdaperState {
	NORMAL,	// Normal debugging
	UNITTEST,	// Debugging or running unit tests
	}


/**
 * The Emulator Debug Adapter.
 * It receives the requests from vscode and sends events to it.
 */
export class DebugSessionClass extends DebugSession {
	/// The state of the debug adapter (unit tests or not)
	protected static state = DbgAdaperState.NORMAL;

	/// The disassembler instance.
	protected dasm: Disassembler;

	/// The address queue for the disassembler. This contains all stepped addresses.
	protected dasmAddressQueue = new Array<number>();

	/// The text document used for the temporary disassembly.
	protected disasmTextDoc: vscode.TextDocument;

	/// A list for the variables (references)
	protected listVariables=new RefList<ShallowVar>();

	/// Only one thread is supported.
	public static THREAD_ID = 1;

	/// Is responsible to serialize asynchronous calls (e.g. to zesarux).
	protected serializer = new CallSerializer("Main", true);

	/// Counts the number of stackTraceRequests.
	protected stackTraceResponses = new Array<DebugProtocol.StackTraceResponse>();

	/// Will be set by startUnitTests to indicate that
	/// unit tests are running and to emit events to the caller.
	protected static unitTestHandler: ((da: DebugSessionClass) => void)|undefined;


	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();

		// Start logging
		Log.clear();
		LogSocket.clear();

		// Init line numbering
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		// Make sure the views listen on 'update' messages.
		this.on('update', BaseView.staticCallUpdateFunctions);

		/*
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', ZesaruxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', ZesaruxDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', ZesaruxDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: ZesaruxBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
		*/
	}


	/**
	 * Start the unit tests.
	 * @param configName The debug launch configuration name.
	 * @param handler
	 * @returns If it was not possible to start unit test: false.
	 */
	public static unitTests(configName: string, handler: (da: DebugSessionClass) => void): boolean {
		assert(handler);

		// Return if currently a debug session is running
		if(vscode.debug.activeDebugSession)
			return false;
		if(this.state != DbgAdaperState.NORMAL)
			return false;

		// Start debugger
		this.unitTestHandler = handler;
		let wsFolder;
		if(vscode.workspace.workspaceFolders)
			wsFolder = vscode.workspace.workspaceFolders[0];
		this.state = DbgAdaperState.UNITTEST;
		vscode.debug.startDebugging(wsFolder, configName);

		return true;
	}

	/**
	 * Checks if the method (functionality) is implemented by the Remote.
	 */
	/*
	protected RemoteHasMethod(name: string): boolean {
		assert(Remote);
		let remote=Remote;
		let found=false;
		while (remote=Object.getPrototypeOf(remote)) {
			const className=remote.constructor.name;
			if (className=="RemoteClass")
				break;	// Stop at RemoteClass
			const methodNames=Object.getOwnPropertyNames(remote);
			found=(methodNames.indexOf(name)>=0);
			if (found) break;
		}
		return found;
	}
	*/

	/**
	 * Creates a new disassembler and configures it.
	 * Called on start of connection.
	 */
	public setupDisassembler() {
		// Create new disassembler.
		this.dasm = new Disassembler();
		// Configure disassembler.
		this.dasm.funcAssignLabels = (addr) => {
			return 'L' + Utility.getHexString(addr,4);
		};
		// Restore 'rst 8' opcode
		Opcodes[0xCF] = new Opcode(0xCF, "RST %s");
		// Setup configuration.
		if(Settings.launch.disassemblerArgs.esxdosRst)
		{
			//Extend 'rst 8' opcode for esxdos
			Opcodes[0xCF].appendToOpcode(",#n");
		}
	}


	/**
	 * Used to show a warning to the user.
	 * @param message The message to show.
	 */
	private showWarning(message: string) {
		Log.log(message);
		vscode.window.showWarningMessage(message);
	}


	/**
	 * Used to show an error to the user.
	 * @param message The message to show.
	 */
	private showError(message: string) {
		Log.log(message);
		vscode.window.showErrorMessage(message);
	}


	/**
	 * Exit from the debugger.
	 * @param message If defined the message is shown to the user as error.
	 */
	public terminate(message?: string) {
		DebugSessionClass.state = DbgAdaperState.NORMAL;
		if(message)
			this.showError(message);
		Log.log("Exit debugger!");
		// Remove all listeners
		this.removeAllListeners();
		// Terminate
		try {
			this.sendEvent(new TerminatedEvent());
		}
		catch(e) {};
		//this.sendEvent(new ExitedEvent());
	}


	/**
	 * Overload sendEvent to logger.
	 */
	public sendEvent(event: DebugProtocol.Event): void {
		Log.log(`<-: ${event.event}(${JSON.stringify(event.body)})`);
		super.sendEvent(event);
	}

	/**
	 * Overload sendRequest to logger.
	 */
	public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
		Log.log(`<-: ${command}(${JSON.stringify(args)})`);
		super.sendRequest(command, args, timeout, (resp) => {
			// Response
			Log.log(`->: ${resp.command}(${JSON.stringify(resp.body)})`);
			// callback
			cb(resp);
		});
	}

	/**
	 * Overload sendResponse to logger.
	 */
	public sendResponse(response: DebugProtocol.Response): void {
		Log.log(`<-: ${response.command}(${JSON.stringify(response.body)})`);
		super.sendResponse(response);
	}

	/**
	 * Writes all requests to the logger.
	 * @param request The DebugProtocol request.
	 */
	protected dispatchRequest(request: DebugProtocol.Request): void {
		Log.log(`->: ${request.command}(${JSON.stringify(request.arguments)})`);
		super.dispatchRequest(request);
	}


	/**
	 * Debugadapter disconnects.
	 * End forcefully.
	 * Is called
	 * - when user presses red square
	 * - when the ZEsarUX socket connection is terminated
	 * Not called:
	 * - If user presses circled arrow/restart.
	 */
	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		DebugSessionClass.state = DbgAdaperState.NORMAL;
		// Close register memory view
		BaseView.staticCloseAll();
		this.removeListener('update', BaseView.staticCallUpdateFunctions);
		// Stop machine
		Remote.disconnect().then(() => {
			this.removeAllListeners();
			this.sendResponse(response);
		});
	}


	/**
	 * 'initialize' request.
	 * Respond with supported features.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		//const dbgSession = vscode.debug.activeDebugSession;
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = false;

		// Is done in launchRequest:
		//response.body.supportsStepBack = true;

		// Maybe terminated on error
		response.body.supportTerminateDebuggee = true;

		// The PC value might be changed.
		//response.body.supportsGotoTargetsRequest = true;
		response.body.supportsGotoTargetsRequest = false;	// I use my own "Move Program Counter to Cursor"

		// Support hovering over values (registers)
		response.body.supportsEvaluateForHovers = true;

		// Support changing of variables (e.g. registers)
		response.body.supportsSetVariable = true;

		// Supports conditional breakpoints
		response.body.supportsConditionalBreakpoints = true;

		// Handles debug 'Restart'
		response.body.supportsRestartRequest = true;

		this.sendResponse(response);

		// Note: The InitializedEvent will be send when the socket connection has been successful. Afterwards the breakpoints are set.
	}


	/**
	 * Called when 'Restart' is pressed.
	 * Disconnects and destroys the old emulator connection and sets up a new one.
	 * @param response
	 * @param args
	 */
	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments) {
		// Stop machine
		Remote.disconnect().then(() => {
			// And setup a new one
			this.launch(response);
		});
	}


	/**
	 * Called after 'initialize' request.
	 * Loads the list file and connects the socket to the zesarux debugger.
	 * Initializes zesarux.
	 * When zesarux is connected and initialized an 'initialized' event
	 * is sent.
	 * @param response
	 * @param args
	 */
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: SettingsParameters) {
		try {
			// Set root path
			Utility.setRootPath((vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders[0].uri.fsPath : '');

			// Save args
			const rootFolder = (vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
			Settings.Init(args, rootFolder);
			Settings.CheckSettings();
		}
		catch(e) {
			// Some error occurred
			response.success = false;
			response.message = e.message;
			this.sendResponse(response);
			return;
		}

		// Launch emulator
		this.launch(response);
	}


	/**
	 * Launches the emulator. Can be called from launchRequest and restartRequest.
	 * @param response
	 */
	protected async launch(response: DebugProtocol.Response) {
		DebugSessionClass.state=DbgAdaperState.NORMAL;
		// Setup the disassembler
		this.setupDisassembler();

		// Start the emulator and the connection.
		const msg=await this.startEmulator();
		if (msg) {
			response.message=msg;
			response.success=(msg==undefined);
		}
		else {
			// Check if reverse debugging is enabled and send capabilities
			if (Settings.launch.history.reverseDebugInstructionCount>0) {
				// Enable reverse debugging
				this.sendEvent(new CapabilitiesEvent({supportsStepBack: true}));
			}
		}
		this.sendResponse(response);
	}


	/**
	 * Starts the emulator and sets up everything for setup after
	 * connection is up and running.
	 * @returns A Promise with an error text or undefined if no error.
	 */
	protected async startEmulator(): Promise<string|undefined> {
		try {
			// init labels
			Labels.init();
		}
		catch(e) {
			// Some error occurred
			this.terminate('Labels: ' + e.message);
			return "Error while initializing labels.";
		}

		// Call the unit test handler. It will subscribe on events.
		if(DebugSessionClass.unitTestHandler) {
			DebugSessionClass.state = DbgAdaperState.UNITTEST;
			DebugSessionClass.unitTestHandler(this);
		}

		// Reset the code coverage and history
		Decoration.clearCodeCoverage();
		Decoration.clearRevDbgHistory();

		// Create the machine
		RemoteFactory.createRemote(Settings.launch.remoteType);

		// Load files
		try {
			// Reads the list file and also retrieves all occurrences of WPMEM, ASSERT and LOGPOINT.
			Remote.readListFiles(Settings.launch.listFiles);
		}
		catch(err) {
			// Some error occurred during loading, e.g. file not found.
		//	this.terminate(err.message);
			return err.message;
		}

		Remote.on('coverage', coveredAddresses => {
			// Covered addresses (since last break) have been sent
			Decoration.showCodeCoverage(coveredAddresses);
		});

		Remote.on('revDbgHistory', addresses => {
			// Reverse debugging history addresses
			Decoration.showRevDbgHistory(addresses);
		});

		Remote.on('historySpot', (startIndex, addresses) => {
			// Short history addresses
			Decoration.showHistorySpot(startIndex, addresses);
		});

		Remote.on('warning', message => {
			// Some problem occurred
			this.showWarning(message);
		});

		Remote.on('log', message => {
			// Show the log (from the socket/ZEsarUX) in the debug console
			vscode.debug.activeDebugConsole.appendLine("Log: " + message);

		});

		Remote.once('error', err => {
			// Some error occurred
			this.terminate(err.message);
		});

		Remote.once('terminated', () => {
			// Emulator has been terminated (e.g. by unit tests)
			this.terminate();
		});

		return new Promise<undefined>(resolve => {	// For now there is no unsuccessful (reject) execution
			Remote.once('initialized', async () => {
				// Create memory/register dump view
				let registerMemoryView=new MemoryRegisterView(this);
				const regs=Settings.launch.memoryViewer.registersMemoryView;
				registerMemoryView.addRegisters(regs);
				registerMemoryView.update();

				// Run user commands after load.
				for (const cmd of Settings.launch.commandsAfterLaunch) {
					vscode.debug.activeDebugConsole.appendLine(cmd);
					try {
						const text=await this.evaluateCommand(cmd);
						vscode.debug.activeDebugConsole.appendLine(text);
					}
					catch (err) {
						// Some problem occurred
						const output="Error while executing '"+cmd+"' in 'commandsAfterLaunch': "+err.message;
						this.showWarning(output);
					}
				}

				// Socket is connected, allow setting breakpoints
				this.sendEvent(new InitializedEvent());
				// Respond
				resolve(undefined);

				// Check if program should be automatically started
				Remote.clearInstructionHistory();
				if (DebugSessionClass.unitTestHandler) {
					// Handle continue/stop in the z80unittests.
					this.emit("initialized");
				}
				else {
					if (Settings.launch.startAutomatically) {
						// The ContinuedEvent is necessary in case vscode was stopped and a restart is done. Without, vscode would stay stopped.
						this.sendEventContinued();
						setTimeout(() => {
							// Delay call because the breakpoints are set afterwards.
							this.remoteContinue();
						}, 500);
					}
					else {
						// Break
						this.sendEvent(new StoppedEvent('stop on start', DebugSessionClass.THREAD_ID));
					}
				}
				DebugSessionClass.unitTestHandler=undefined;
			});
			Remote.init();
		});
	}




	/**
	 * The breakpoints are set for a path (file).
	 * @param response
	 * @param args lines=array with line numbers. source.path=the file path
	 */
	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		// Serialize
		this.serializer.exec(async () => {

			const path = <string>args.source.path;

			// convert breakpoints
			const givenBps = args.breakpoints || [];
			const bps = new Array<RemoteBreakpoint>();
			for(const bp of givenBps) {
				try {
					const log = Remote.evalLogMessage(bp.logMessage);
					var mbp: RemoteBreakpoint;
					mbp = {
						bpId: 0,
						filePath: path,
						lineNr: this.convertClientLineToDebugger(bp.line),
						address: -1,	// not known yet
						condition: (bp.condition) ? bp.condition : '',
						log: log
					};
					bps.push(mbp);
					}
				catch(e) {
					// Show error
					this.showWarning(e);
				}
			};


			// Set breakpoints for the file.
			const currentBreakpoints=await Remote.setBreakpoints(path, bps,
				// Handle temporary disassembler breakpoints
				(bp: RemoteBreakpoint) => {
					// Check if it is the right path
					const relFilePath=Utility.getRelTmpDisasmFilePath();
					const absFilePath=Utility.getAbsFilePath(relFilePath);
					if (bp.filePath==absFilePath) {
						// Get address from line number
						const lines=this.dasm.getDisassemblyLines();
						const lineCount=lines.length;
						let lineNr=bp.lineNr;
						while (lineNr<lineCount) {
							const line=lines[lineNr];
							const addr=parseInt(line, 16);
							if (!isNaN(addr)) {
								// create breakpoint object
								const ebp={bpId: 0, filePath: bp.filePath, lineNr: lineNr, address: addr, condition: bp.condition, log: bp.log};
								return ebp;
							}
							lineNr++;
						}
					}
					return undefined;
				});

			const source=this.createSource(path);
			const vscodeBreakpoints=currentBreakpoints.map(cbp => {
				const lineNr=this.convertDebuggerLineToClient(cbp.lineNr);
				const verified=(cbp.address>=0);	// Is not verified if no address is set
				let bp=new Breakpoint(verified, lineNr, 0, source);
				return bp;
			});

			// send back the actual breakpoint positions
			response.body={
				breakpoints: vscodeBreakpoints
			};
			this.sendResponse(response);
			this.serializer.endExec();
		});

	}


	/**
	 * Returns the one and only "thread".
	 */
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// Serialize
		this.serializer.exec(() => {
			// Just return a default thread.
			response.body = {
				threads: [
					new Thread(DebugSessionClass.THREAD_ID, "thread_default")
				]
			};
			this.sendResponse(response);
			this.serializer.endExec();
		});
	}



	/**
	 * Creates a source reference from the filePath.
	 * @param filePath
	 * @returns undefined if filePath is ''.
	 */
	private createSource(filePath: string): Source|undefined {
		if(filePath.length == 0)
			return undefined;
		const fname = basename(filePath);
		const debPath = this.convertDebuggerPathToClient(filePath);
		return new Source(fname, debPath, undefined, undefined, undefined);
	}


	/**
	 * Returns the stack frames.
	 */
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		// vscode sometimes sends 2 stack trace requests one after the other. Because the lists are cleared this can lead to race conditions.
		this.stackTraceResponses.push(response);
		if(this.stackTraceResponses.length > 1)
			return;

		// Stack frames
		const sfrs = new Array<StackFrame>();

		// Need to check if disassembly is required.
		let doDisassembly = false;
		const fetchAddresses = new Array<number>();
		const fetchData = new Array<Uint8Array>();
		let frameCount = 0;


		// Serialize
		this.serializer.exec(() => {
			// Clear all variables
			this.listVariables.length=0;

			// Get the call stack trace.
			Remote.stackTraceRequest().then(callStack => {
				// Go through complete call stack and get the sources.
				// If no source exists than get a hexdump and disassembly later.
				frameCount=callStack.length;
				for (let index=frameCount-1; index>=0; index--) {
					const frame=callStack[index];
					// Get file for address
					const addr=frame.addr;
					const file=Labels.getFileAndLineForAddress(addr);
					// Store file, if it does not exist the name is empty
					const src=this.createSource(file.fileName);
					const lineNr=(src)? this.convertDebuggerLineToClient(file.lineNr):0;
					const sf=new StackFrame(index+1, frame.name, src, lineNr);
					sfrs.push(sf);
					// Create array with addresses that need to be fetched for disassembly
					if (!sf.source) {
						const frame=callStack[index];
						fetchAddresses.push(frame.addr);
					}
				}

				// Check if we need to fetch any dump.
				const fetchAddressesCount=fetchAddresses.length;
				if (fetchAddressesCount==0) {
					// No dumps to fetch
					this.serializer.endExec();
					return;
				}

				// Now get hexdumps for all non existing sources.
				let fetchCount=0;
				for (let index=0; index<fetchAddressesCount; index++) {
					// So fetch a memory dump
					const fetchAddress=fetchAddresses[index];
					const fetchSize=100;	// N bytes
					Remote.readMemoryDump(fetchAddress, fetchSize)
						.then(data => {
						// Save data for later writing
						fetchData.push(data);
						// Note: because of self-modifying code it may have changed
						// since it was fetched at the beginning.
						// Check if memory changed.
						if (!doDisassembly) {
							const checkSize=40;	// Needs to be smaller than fetchsize in order not to do a disassembly too often.
							for (let k=0; k<checkSize; k++) {
								const val=this.dasm.memory.getValueAt(fetchAddress+k);
								const memAttr=this.dasm.memory.getAttributeAt(fetchAddress+k);
								if ((val!=data[k])||(memAttr==MemAttribute.UNUSED)) {
									doDisassembly=true;
									break;
								}
							}
						}
						// Check for end
						fetchCount++;
						if (fetchCount>=fetchAddressesCount) {
							// All dumps fetched
							this.serializer.endExec();
						}
					});
				}
			});
		});


		// Create the temporary disassembly file if necessary.
		if(!this.disasmTextDoc) {
			this.serializer.exec(() => {
				if(!doDisassembly) {
					// No disassembly required.
					this.serializer.endExec();
					return;
				}
				// Create text document
				const relFilePath = Utility.getRelTmpDisasmFilePath();
				const absFilePath = Utility.getAbsFilePath(relFilePath);
				const uri = vscode.Uri.file(absFilePath);
				const editCreate = new vscode.WorkspaceEdit();
				editCreate.createFile(uri, {overwrite: true});
				vscode.workspace.applyEdit(editCreate).then(() => {
					vscode.workspace.openTextDocument(absFilePath).then(textDoc => {
						// Store uri
						this.disasmTextDoc = textDoc;
						// End
						this.serializer.endExec();
					});
				});
			});
		}


		// Check if disassembly is required.
		this.serializer.exec(() => {
			// Check if a new address was used.
			const fetchAddressesCount = fetchAddresses.length;
			for(let i=0; i<fetchAddressesCount; i++) {
				// The current PC is for sure a code label.
				const addr = fetchAddresses[i];
				if(this.dasmAddressQueue.indexOf(addr) < 0)
					this.dasmAddressQueue.unshift(addr);
				// Check if this requires a  disassembly
				if(!doDisassembly) {
					const memAttr = this.dasm.memory.getAttributeAt(addr);
					if(!(memAttr & MemAttribute.CODE_FIRST))
						doDisassembly = true;	// If memory was not the start of an opcode.
				}
			}

			// Check if disassembly is required.
			if(!doDisassembly) {
				// End
				this.serializer.endExec();
				return;
			}

			this.serializer.setProgress("Do disassembly");
			// Do disassembly.
			// Write new fetched memory
			const count = fetchAddresses.length;
			for(let i=0; i<count; i++) {
				this.dasm.setMemory(fetchAddresses[i], fetchData[i]);
			}
			this.dasm.setAddressQueue(this.dasmAddressQueue);
			// Disassemble
			this.dasm.memory.clrAssignedAttributesAt(0x0000, 0x10000);	// Clear all memory attributes before next disassembly.
			this.dasm.initLabels();	// Clear all labels.
			this.dasm.disassemble();
			// Read data
			const text = this.dasm.getDisassemblyText();
			// Get all source breakpoints of the disassembly file.
			const bps = vscode.debug.breakpoints;
			const disSrc = this.disasmTextDoc.uri.toString();
			const sbps = bps.filter(bp => {
				if(bp.hasOwnProperty('location')) {
					const sbp = bp as vscode.SourceBreakpoint;
					const sbpSrc = sbp.location.uri.toString();
					if(sbpSrc == disSrc)
						return true;
				}
				return false;
			}) as vscode.SourceBreakpoint[];

			this.serializer.setProgress("Check if any breakpoint");
			// Check if any breakpoint
			const changedBps = new Array<vscode.SourceBreakpoint>();
			if(sbps.length > 0) {
				// Previous text
				const prevTextLines = this.disasmTextDoc.getText().split('\n');

				// Loop all source breakpoints to compute changed BPs
				for(const sbp of sbps) {
					const lineNr = sbp.location.range.start.line;
					const line = prevTextLines[lineNr];
					const addr = parseInt(line, 16);
					if(!isNaN(addr)) {
						// Get new line
						const lines = this.dasm.getDisassemblyLines();
						const nLineNr = this.searchLines(lines, addr);
						// Create breakpoint
						const nLoc = new vscode.Location(this.disasmTextDoc.uri, new vscode.Position(nLineNr, 0));
						const cbp = new vscode.SourceBreakpoint(nLoc, sbp.enabled, sbp.condition, sbp.hitCondition, sbp.logMessage);
						// Store
						changedBps.push(cbp);
					}
				}
			}

			this.serializer.setProgress("Remove all old breakpoints");
			// Remove all old breakpoints.
			vscode.debug.removeBreakpoints(sbps);

			// Create and apply one replace edit
			const editReplace = new vscode.WorkspaceEdit();
			editReplace.replace(this.disasmTextDoc.uri, new vscode.Range(0, 0, this.disasmTextDoc.lineCount, 0), text);
			this.serializer.setProgress("applyEdit");
			vscode.workspace.applyEdit(editReplace).then(() => {
				// Save after edit (to be able to set breakpoints)
				this.serializer.setProgress("disasmTextDoc.save");
				this.disasmTextDoc.save().then(() => {
					this.serializer.setProgress("debug.addBreakpoints");
					// Add all new breakpoints.
					vscode.debug.addBreakpoints(changedBps);
					// End
					this.serializer.endExec();
				});
			});
		});


		// Get lines for addresses and send response.
		this.serializer.exec(() => {
			// Determine line numbers (binary search)
			if(frameCount > 0) {
				const relFilePath = Utility.getRelTmpDisasmFilePath();
				const absFilePath = Utility.getAbsFilePath(relFilePath);
				const src = this.createSource(absFilePath) as Source;
				const lines = this.dasm.getDisassemblyLines();
				let indexDump = 0;
				for(let i=0; i<frameCount; i++) {
					const sf = sfrs[i];
					if(sf.source)
						continue;
					// Get line number for stack address
					const addr = fetchAddresses[indexDump];
					const foundLine = this.searchLines(lines, addr);
					const lineNr = this.convertDebuggerLineToClient(foundLine);
					// Store
					sf.source = src;
					sf.line = lineNr;
					// Next
					indexDump ++;
				}
			}

			// Send as often as there have been requests
			while(this.stackTraceResponses.length > 0) {
				const resp = this.stackTraceResponses[0];
				this.stackTraceResponses.shift();
				resp.body = {stackFrames: sfrs,	totalFrames: 1};
				this.sendResponse(resp);
			}
			// end the serialized call:
			this.serializer.endExec();
		});


		// Get short history decoration.
		this.serializer.exec(() => {
			Remote.handleHistorySpot();
			// end the serialized call:
			this.serializer.endExec();
		});
	}


	/**
	 * Does a search to find the (last) line that correspondents to the
	 * given address.
	 * The array usually contains lines with a starting address.
	 * But it may also contain empty lines or lines not starting with a number.
	 * Those lines are skipped.
	 * @param allLines An array to be searched. Can contain lines without address.
	 * @param addr The address to find.
	 * @return -1 if not found, otherwise the line number.
	 */
	protected searchLines(allLines: Array<string>, addr: number) {
		// find each new line and count the lines
		let i = allLines.length;
		while(i > 0) {
			i --;
			const line = allLines[i];
			const la = parseInt(line, 16);
			if(la == addr)
				return  i;
		}
		// Not found
		return -1;
	}


	/**
	 * Returns the different scopes. E.g. 'Disassembly' or 'Registers' that are shown in the Variables area of vscode.
	 * @param response
	 * @param args
	 */
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const scopes = new Array<Scope>();
		const frameId = args.frameId;
		//const frame = this.listFrames.getObject(frameId);
		const frame = Remote.getFrame(frameId);
		if(!frame) {
			// No frame found, send empty response
			response.body = {scopes: scopes};
			this.sendResponse(response);
			return;
		}

		// Create variable object for Registers
		const varRegistersMain = new RegistersMainVar();
		// Add to list and get reference ID
		let ref = this.listVariables.addObject(varRegistersMain);
		scopes.push(new Scope("Registers", ref));

		// Create variable object for secondary Registers
		const varRegisters2 = new RegistersSecondaryVar();
		// Add to list and get reference ID
		const ref2 = this.listVariables.addObject(varRegisters2);
		scopes.push(new Scope("Registers 2", ref2));

		// get address
		if(frame) {
			// use address
			const addr = frame.addr;
			// Create variable object for Disassembly
			const varDisassembly = new DisassemblyVar(addr, 8);
			// Add to list and get reference ID
			const ref = this.listVariables.addObject(varDisassembly);
			scopes.push(new Scope("Disassembly", ref));
		}

		// Check if memory pages are suported by Remote
		if (Remote.supportsZxNextRegisters) {
			// Create variable object for MemoryPages
			const varMemoryPages=new MemoryPagesVar();
			// Add to list and get reference ID
			ref=this.listVariables.addObject(varMemoryPages);
			scopes.push(new Scope("Memory Pages", ref));
		}

		// Create variable object for the stack
		const varStack = new StackVar(frame.stack, frame.stackStartAddress);
		// Add to list and get reference ID
		ref = this.listVariables.addObject(varStack);
		scopes.push(new Scope("Stack", ref));

		// Send response
		response.body = {scopes: scopes};
		this.sendResponse(response);
	}


	/**
	 * Returns the variables for the scopes (e.g. 'Disassembly' or 'Registers')
	 * @param response
	 * @param args
	 */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		// Get the associated variable object
		const ref = args.variablesReference;
		const varObj = this.listVariables.getObject(ref);
		// Serialize
		this.serializer.exec(() => {
			// Check if object exists
			if(!varObj) {
				// Return empty list
				var variables = new Array<DebugProtocol.Variable>();
				response.body = {variables: variables};
				this.sendResponse(response);
				// end the serialized call:
				this.serializer.endExec();
				return;
			}
			// Get contents
			varObj.getContent(args.start, args.count).then(varList => {
				response.body = {variables: varList};
				this.sendResponse(response);
				// end the serialized call:
				this.serializer.endExec();
			});
		});
	}


	/**
	 * Decorates the current PC source line with a reason.
	 * @oaram "Breakpoint fired: PC=811EH" or undefined (prints nothing)
	 */
	public decorateBreak(breakReason: string) {
		if(!breakReason)
			return;
		// Get PC
		Remote.getRegisters().then(() => {
			const pc = Remote.getPC();
			Decoration.showBreak(pc, breakReason);
		});
	}


	/**
	  * vscode requested 'continue'.
	  * @param response
	  * @param args
	  */
	 public continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		// Serialize
		this.serializer.exec(() => {
			// Continue debugger
			this.remoteContinue();
			this.sendResponse(response);
			this.serializer.endExec();
		});
	}


	/**
	 * Calls 'continue' (run) on the remote (emulator).
	 * Called at the beginning (startAutomatically) and from the
	 * vscode UI (continueRequest).
	 */
	public remoteContinue() {
		Decoration.clearBreak();
		Remote.continue().then(result => {
			// It returns here not immediately but only when a breakpoint is hit or pause is requested.

			// Display T-states and time
			this.showUsedTStates('Continue. ', result.tStates, result.cpuFreq);

			if (result.breakReason) {
				// Send output event to inform the user about the reason
				vscode.debug.activeDebugConsole.appendLine(result.breakReason);

				// Use reason for break-decoration.
				this.decorateBreak(result.breakReason);
			}

			// React depending on internal state.
			if(DebugSessionClass.state == DbgAdaperState.NORMAL) {
				// Send break
				this.sendEventBreakAndUpdate();
			}
			else {
				// For the unit tests
				this.emit("break");
			}
		});
	}


	/**
	 * Is called by unit tests to simulate a 'break'.
	 */
	public sendEventBreakAndUpdate() {
		// Update memory dump etc.
		this.update();
		// Send event
		this.sendEvent(new StoppedEvent('break', DebugSessionClass.THREAD_ID));
	}


	/**
	 * Sends a continued event to update the UI.
	 */
	public sendEventContinued() {
		// Send event
		this.sendEvent(new ContinuedEvent(DebugSessionClass.THREAD_ID));
	}


	/**
	  * vscode requested 'pause'.
	  * @param response
	  * @param args
	  */
	 protected pauseRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		// Serialize
		//this.serializer.exec(() => {
			// Pause the debugger
			Remote.pause();
			// Response is sent immediately
			this.sendResponse(response);
		//	this.serializer.endExec();
		//});
	}


	 /**
	  * vscode requested 'reverse continue'.
	  * @param response
	  * @param args
	  */
	 protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		Decoration.clearBreak();
		// Serialize
		this.serializer.exec(() => {
			// Output
			vscode.debug.activeDebugConsole.appendLine('Continue reverse...');

			// Continue debugger
			Remote.reverseContinue().then(breakReason => {
				if(breakReason) {
					// Output a possible problem
					vscode.debug.activeDebugConsole.appendLine(breakReason);
					// Show break reason
					this.decorateBreak(breakReason);
				}
				// Update memory dump etc.
				this.update();
				// It returns here not immediately but only when a breakpoint is hit or pause is requested.
				this.sendEvent(new StoppedEvent('break', DebugSessionClass.THREAD_ID));
			});

			// Response is sent immediately
			this.sendResponse(response);
			this.serializer.endExec();
		});
	}


	/**
		* Step over.
		* Called from UI (vscode) and from the unit tests.
	  */
	 public emulatorStepOver() {
		Decoration.clearBreak();
		// Step-Over
		 Remote.stepOver().then(result => {
			// Display T-states and time
			 let text=result.instruction || '';
			 if (result.tStates||result.cpuFreq)
				text += ' \t; ';
			 this.showUsedTStates('StepOver: '+text, result.tStates, result.cpuFreq);

			// Update memory dump etc.
			this.update({step: true});

			// Send event
			this.sendEvent(new StoppedEvent('step', DebugSessionClass.THREAD_ID));

			 if (result.breakReason) {
				// Output a possible problem
				vscode.debug.activeDebugConsole.appendLine(result.breakReason);
				// Show break reason
				this.decorateBreak(result.breakReason);
			}
		});
	}


	/**
	  * vscode requested 'step over'.
	  * @param response	Sends the response. If undefined nothingis sent. USed by Unit Tests.
	  * @param args
	  */
	 protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		Decoration.clearBreak();
		// Step-Over
		this.emulatorStepOver();	// Sends stopped request.

		 // Response is sent immediately
		 this.sendResponse(response);
	}


	/**
	 * Prints the used T-states and time to the debug console.
	 * @param disasm The corresponding disassembly.
	 * @param tStates The used T-States.
	 * @param cpuFreq The CPU clock frequency in Hz.
	 */
	protected showUsedTStates(disasm: string, tStates?: number, cpuFreq?: number) {
		// Display T-states and time
		let output = disasm;
		if(tStates) {
			output += 'T-States: ' + tStates;
			if(cpuFreq) {
				// Time
				let time = tStates/cpuFreq;
				let unit = 's';
				if(time < 1e-3) {
					time *= 1e+6;
					unit = 'us';
				}
				else if(time < 1) {
					time *= 1e+3;
					unit = 'ms';
				}
				// CPU clock
				let clockStr = (cpuFreq * 1E-6).toPrecision(2);
				if(clockStr.endsWith('.0'))
					clockStr = clockStr.substr(0, clockStr.length-2);
					output += ', time: ' + time.toPrecision(3) + unit + '@' + clockStr + 'MHz';
			}
		}
		vscode.debug.activeDebugConsole.appendLine(output);
	}


	/**
	  * vscode requested 'step into'.
	  * @param response
	  * @param args
	  */
	protected stepInRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		Decoration.clearBreak();
		// Serialize
		this.serializer.exec(() => {
			// Step-Into
			Remote.stepInto().then(result => {
				// Display T-states and time
				let text=result.instruction||'';
				if (result.tStates||result.cpuFreq)
					text+=' \t; ';
				this.showUsedTStates('StepInto: '+text, result.tStates, result.cpuFreq);

				// Update memory dump etc.
				this.update({step: true});

				// Output a possible problem ("end of cpu history reached")
				if (result.breakReason)
					vscode.debug.activeDebugConsole.appendLine(result.breakReason);

				// Response
				this.serializer.endExec();

				// Send event
				this.sendEvent(new StoppedEvent('step', DebugSessionClass.THREAD_ID));
			});

			// Response is sent immediately
			this.sendResponse(response);
		});
	}


	 /**
	  * vscode requested 'step out'.
	  * @param response
	  * @param args
	  */
	 protected stepOutRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		Decoration.clearBreak();
		// Serialize
//		this.serializer.exec(() => {
			// Step-Out
			Remote.stepOut().then(result => {
				// Display T-states and time
				this.showUsedTStates('StepOut. ', result.tStates, result.cpuFreq);

				if (result.breakReason) {
					// Output a possible problem (end of log reached)
					vscode.debug.activeDebugConsole.appendLine(result.breakReason);
					// Show break reason
					this.decorateBreak(result.breakReason);
				}

				// Update memory dump etc.
				this.update();

				// Send event
				this.sendEvent(new StoppedEvent('step', DebugSessionClass.THREAD_ID));
			});

			// Response is sent immediately
			this.sendResponse(response);
//			this.serializer.endExec();
//		});
	}


	/**
	  * vscode requested 'step backwards'.
	  * @param response
	  * @param args
	  */
	 protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		Decoration.clearBreak();
		// Serialize
		 this.serializer.exec(() => {
			 // Step-Back
			 Remote.stepBack().then(result => {
				 // Print
				 vscode.debug.activeDebugConsole.appendLine('StepBack: '+result.instruction);

				 if (result.breakReason) {
					 // Output a possible problem (end of log reached)
					 vscode.debug.activeDebugConsole.appendLine(result.breakReason);
					 // Show break reason
					 this.decorateBreak(result.breakReason);
				 }

				 // Update memory dump etc.
				 this.update({step: true});

				 // Response
				 this.sendResponse(response);
				 this.serializer.endExec();

				 // Send event
				 this.sendEvent(new StoppedEvent('step', DebugSessionClass.THREAD_ID));
			 });
		 });
	}


	/**
	 * Evaluates the command and executes it.
	 * The method might throw an exception if it cannot parse the command.
	 * @param command E.g. "-exec tbblue-get-register 57" or "-wpmem disable".
	 * @returns A Promise<string> with an text to output (e.g. an error).
	 */
	protected async evaluateCommand(command: string): Promise<string> {
		const expression = command.trim();
		const tokens = expression.split(' ');
		const cmd = tokens.shift();
		// All commands start with "-"
		if(cmd == '-help' || cmd == '-h') {
			return await this.evalHelp(tokens);
		}
		else if (cmd == '-LOGPOINT' || cmd == '-logpoint') {
			return await this.evalLOGPOINT(tokens);
		}
		else if (cmd == '-ASSERT' || cmd == '-assert') {
			return await this.evalASSERT(tokens);
		}
		else if (cmd == '-eval') {
			return await this.evalEval(tokens);
		}
		else if (cmd == '-exec' || cmd == '-e') {
			return await this.evalExec(tokens);
		}
		else if (cmd == '-label' || cmd == '-l') {
			return await this.evalLabel(tokens);
		}
		else if (cmd == '-md') {
			return await this.evalMemDump(tokens);
		}
		else if (cmd == '-patterns') {
			return await this.evalSpritePatterns(tokens);
		}
		else if (cmd == '-WPMEM' || cmd == '-wpmem') {
			return await this.evalWPMEM(tokens);
		}
		else if (cmd == '-sprites') {
			return await this.evalSprites(tokens);
		}
		else if (cmd == '-state') {
			return await this.evalStateSaveRestore(tokens);
		}
		else if (cmd == '-unittests') {
			return await this.evalStateSaveRestore(tokens);
		}
		// Debug commands
		else if (cmd == '-dbg') {
			return await this.evalDebug(tokens);
		}
		//
		else {
			// Unknown command
			throw new Error("Unknown command: '" + expression + "'");
		}
	}


	/**
	 * Is called when hovering or when an expression is added to the watches.
	 * Or if commands are input in the debug console.
	 */
	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
		// Check if its a debugger command
		const expression = args.expression.trim();
		const tokens = expression.split(' ');
		const cmd=tokens.shift();
		if (cmd == undefined) {
			this.sendResponse(response);
			return;
		}

		if (expression.startsWith('-')) {
			try {
				if (expression.startsWith('-')) {
					const text=await this.evaluateCommand(expression);
					this.sendEvalResponse(text, response);
				}
			}
			catch (err) {
				const output="Error: "+err.message;
				this.sendEvalResponse(output, response);
			}
			return;
		}

		Log.log('evaluate.expression: ' + args.expression);
		Log.log('evaluate.context: ' + args.context);
		Log.log('evaluate.format: ' + args.format);

		// get the name
		const name = expression;
		// Check if it is a register
		if (Z80Registers.isRegister(name)) {
			const formatMap=(args.context=='hover')? Z80RegisterHoverFormat:Z80RegisterVarFormat;
			const formattedValue=await Utility.getFormattedRegister(name, formatMap); response.body={
				result: formattedValue,
				variablesReference: 0
			};
			this.sendResponse(response);
			return;
		}

		// Check if it is a label. A label may have a special formatting:
		// Example: LBL_TEXT 10, b
		// = Addresse LBL_TEXT, 10 bytes
		const match = /^@?([^\s,]+)\s*(,\s*([^\s,]*))?(,\s*([^\s,]*))?/.exec(name);
		if(match) {
			let labelString = match[1];
			let sizeString = match[3];
			let byteWord = match[5];
			// Defaults
			if(labelString) {
				let labelValue = NaN;
				let lastLabel;
				let modulePrefix;
				// First check for module name and local label prefix (sjasmplus).
				Remote.getRegisters().then(() => {
					const pc = Remote.getPC();
					const entry = Labels.getFileAndLineForAddress(pc);
					// Local label and prefix
					lastLabel = entry.lastLabel;
					modulePrefix = entry.modulePrefix;

					// Convert label
					try {
						labelValue = Utility.evalExpression(labelString, false, modulePrefix, lastLabel);
					} catch { }

					if (isNaN(labelValue)) {
						// Return empty response
						this.sendResponse(response);
						return;
					}

					// Is a number
					var size = 100;
					if (sizeString) {
						const readSize = Labels.getNumberFromString(sizeString) || NaN;
						if (!isNaN(readSize))
							size = readSize;
					}
					if (!byteWord || byteWord.length == 0)
						byteWord = "bw";	// both byte and word
					// Now create a "variable" for the bigValues or small values
					const format = (labelValue <= Settings.launch.smallValuesMaximum) ? Settings.launch.formatting.smallValues : Settings.launch.formatting.bigValues;
					Utility.numberFormatted(name, labelValue, 2, format, undefined).then(formattedValue => {
						if (labelValue <= Settings.launch.smallValuesMaximum) {
							// small value
							// Response
							response.body = {
								result: (args.context == 'hover') ? name + ': ' + formattedValue : formattedValue,
								variablesReference: 0,
								//type: "data",
								//amedVariables: 0
							}
						}
						else {
							// big value
							// Create a label variable
							const labelVar = new LabelVar(labelValue, size, byteWord, this.listVariables);
							// Add to list
							const ref = this.listVariables.addObject(labelVar);
							// Response
							response.body = {
								result: (args.context == 'hover') ? name + ': ' + formattedValue : formattedValue,
								variablesReference: ref,
								type: "data",
								//presentationHint: ,
								namedVariables: 2,
								//indexedVariables: 100
							};
						}
						this.sendResponse(response);
					});
				});	// Emulator.getRegisters
				return;
			}	// If labelString
		}	// If match

		// Default: return nothing
		this.sendResponse(response);
	}


	/**
	 * Prints a help text for the debug console commands.
	 * @param tokens The arguments. Unused.
 	 * @param A Promise with a text to print.
	 */
	protected async evalHelp(tokens: Array<string>): Promise<string> {
		const output =
`Allowed commands are:
"-ASSERT enable|disable|status":
	- enable|disable: Enables/disables all breakpoints caused by ASSERTs set in the sources. All ASSERTs are by default enabled after startup of the debugger.
	- status: Shows enable status of ASSERT breakpoints.
"-eval expr": Evaluates an expression. The expression might contain
mathematical expressions and also labels. It will also return the label if
the value correspondends to a label.
"-exec|e [-view] cmd args": cmd and args are directly passed to ZEsarUX. E.g. "-exec get-registers". If you add "-view" the output will go into a new view instead of the console.
"-help|h": This command. Do "-e help" to get all possible ZEsarUX commands.
"-label|-l XXX": Returns the matching labels (XXX) with their values. Allows wildcard "*".
"-LOGPOINT enable|disable|status [group]":
	- enable|disable: Enables/disables all logpoints caused by LOGPOINTs of a certain group set in the sources. If no group is given all logpoints are affected. All logpoints are by default disabled after startup of the debugger.
	- status: Shows enable status of LOGPOINTs per group.
"-md address size [address_n size_n]*": Memory Dump at 'address' with 'size' bytes. Will open a new view to display the memory dump.
"-patterns [index[+count|-endindex] [...]": Shows the tbblue sprite patterns beginning at 'index' until 'endindex' or a number of 'count' indices. The values can be omitted. 'index' defaults to 0 and 'count' to 1.
Without any parameter it will show all sprite patterns.
You can concat several ranges.
Example: "-patterns 10-15 20+3 33" will show sprite patterns at index 10, 11, 12, 13, 14, 15, 20, 21, 22, 33.
"-WPMEM enable|disable|status":
	- enable|disable: Enables/disables all WPMEM set in the sources. All WPMEM are by default enabled after startup of the debugger.
	- status: Shows enable status of WPMEM watchpoints.
"-sprites [slot[+count|-endslot] [...]": Shows the tbblue sprite registers beginning at 'slot' until 'endslot' or a number of 'count' slots. The values can be omitted. 'slot' defaults to 0 and 'count' to 1. You can concat several ranges.
Example: "-sprite 10-15 20+3 33" will show sprite slots 10, 11, 12, 13, 14, 15, 20, 21, 22, 33.
Without any parameter it will show all visible sprites automatically.
"-state save|restore": Saves/restores the current state. I.e. the complete RAM + the registers.

Examples:
"-exec h 0 100": Does a hexdump of 100 bytes at address 0.
"-e write-memory 8000h 9fh": Writes 9fh to memory address 8000h.
"-e gr": Shows all registers.
"-eval 2+3*5": Results to "17".
"-md 0 10": Shows the memory at address 0 to address 9.
"-sprites": Shows all visible sprites.
Notes:
"-exec run" will not work at the moment and leads to a disconnect.
`;
/*
For debugging purposes there are a few more:
-dbg serializer clear: Clears the call serializer queue.
-dbg serializer print: Prints the current function. Use this to see where
it hangs if it hangs. (Use 'setProgress' to debug.)
*/
		return output;
	}


	/**
	 * Evaluates a given expression.
	 * @param tokens The arguments. I.e. the expression to evaluate.
 	 * @returns A Promise with a text to print.
	 */
	protected async evalEval(tokens: Array<string>): Promise<string> {
		const expr = tokens.join(' ').trim();	// restore expression
		if(expr.length == 0) {
			// Error Handling: No arguments
			throw new Error("Expression expected.");
		}
		// Evaluate expression
		let result;
		// Evaluate
		const value = Utility.evalExpression(expr);
		// convert to decimal
		result = value.toString();
		// convert also to hex
		result += ', ' + value.toString(16).toUpperCase() + 'h';
		// convert also to bin
		result += ', ' + value.toString(2) + 'b';
		// check for label
		const labels = Labels.getLabelsPlusIndexForNumber(value);
		if(labels.length > 0) {
			result += ', ' + labels.join(', ');
		}

		return result;
	}


	/**
	 * Executes a command in the emulator.
	 * @param tokens The arguments. I.e. the command for the emulator.
 	 * @returns A Promise with a text to print.
	 */
	protected async evalExec(tokens: Array<string>): Promise<string> {
		// Check for "-view"
		let redirectToView=false;
		if (tokens[0]=='-view') {
			redirectToView=true;
			tokens.shift();
		}
		// Execute
		const machineCmd=tokens.join(' ');
		const textData=await Remote.dbgExec(machineCmd);
		if (redirectToView) {
			// Create new view
			const panel=new TextView(this, "exec: "+machineCmd, textData);
			panel.update();
			// Send response
			return 'OK';
		}
		// Print to console
		return textData;
	}


	/**
	 * Evaluates a label.
	 * @param tokens The arguments. I.e. the label.
 	 * @returns A Promise with a text to print.
	 */
	protected async evalLabel(tokens: Array<string>): Promise<string> {
		const expr = tokens.join(' ').trim();	// restore expression
		if(expr.length == 0) {
			// Error Handling: No arguments
			return "Label expected.";
		}

		// Find labelwith regex, every star is translated into ".*"
		const rString = '^' + Utility.replaceAll(expr, '*', '.*?') + '$';
		// Now search all labels
		const labels = Labels.getLabelsForRegEx(rString);
		let result = '';
		if(labels.length > 0) {
			labels.map(label => {
				const value = Labels.getNumberForLabel(label);
				result += label +': ' + Utility.getHexString(value, 4) + 'h\n';
			})
		}
		else {
			// No label found
			result = 'No label matches.';
		}
		// return result
		return result;
	}


	/**
	 * Shows a view with a memory dump.
	 * @param tokens The arguments. I.e. the address and size.
 	 * @returns A Promise with a text to print.
	 */
	protected async evalMemDump(tokens: Array<string>): Promise<string> {
		// check count of arguments
		if(tokens.length == 0) {
			// Error Handling: No arguments
			throw new Error("Address and size expected.");
		}

		if(tokens.length % 2 != 0) {
			// Error Handling: No size given
			throw new Error("No size given for address '" + tokens[tokens.length-1] + "'.");
		}

		// Get all addresses/sizes.
		const addrSizes = new Array<number>();
		for(let k=0; k<tokens.length; k+=2) {
			// address
			const addressString = tokens[k];
			const address = Utility.evalExpression(addressString);
			addrSizes.push(address);

			// size
			const sizeString = tokens[k+1];
			const size = Utility.evalExpression(sizeString);
			addrSizes.push(size);
		}

		// Create new view
		const panel = new MemoryDumpView(this);
		for(let k=0; k<tokens.length; k+=2)
			panel.addBlock(addrSizes[k], addrSizes[k+1]);
		panel.mergeBlocks();
		panel.update();

		// Send response
		return 'OK';
	}


	/**
	 * LOGPOINTS. Enable/disable/status.
	 * @param tokens The arguments.
 	 * @returns A Promise<string> with a probably error text.
	 */
	protected async evalLOGPOINT(tokens: Array<string>): Promise<string> {
			const show=() => {
			// Always show enable status of all Logpoints
			const enableMap=Remote.logpointsEnabled;
			// All groups:
			let text='LOGPOINT groups:';
			for (const [group, enable] of enableMap) {
				text+='\n  '+group+': '+((enable)? 'enabled':'disabled');
			}
			return text;
		}

		const param=tokens[0]||'';
		const group=tokens[1];
		if (param=='enable'||param=='disable') {
			// enable or disable all logpoints
			const enable=(param=='enable');
			await Remote.enableLogpoints(group, enable);
			return show();	// Print to console
		}
		else if (param=='status') {
			// just show
			return show();
		}
		else {
			// Unknown argument
			throw new Error("Unknown argument: '"+param+"'");
		}
	}


	/**
	 * ASSERT. Enable/disable/status.
	 * @param tokens The arguments.
 	 * @returns A Promise<string> with a probably error text.
	 */
	protected async evalASSERT(tokens: Array<string>): Promise<string> {
		const show = () => {
			// Always show enable status of all ASSERT breakpoints
			const enable = Remote.assertBreakpointsEnabled;
			const enableString = (enable) ? 'enabled' : 'disabled';
			return 'ASSERT breakpoints are ' + enableString + '.';
		}

		const param = tokens[0] || '';
		if(param == 'enable' || param == 'disable') {
			// enable or disable all assert breakpoints
			const enable = (param == 'enable');
			await Remote.enableAssertBreakpoints(enable);
			return show();	// Print to console
		}
		else if(param == 'status') {
			// Just show
			return show();
		}
		else {
			// Unknown argument
			throw new Error("Unknown argument: '" + param + "'");
		}
	}


	/**
	 * WPMEM. Enable/disable/status.
	 * @param tokens The arguments.
 	 * @returns A Promise<string> with a text to print.
	 */
	protected async evalWPMEM(tokens: Array<string>): Promise<string> {
		const show = () => {
			// Always show enable status of all WPMEM watchpoints
			const enable = Remote.wpmemEnabled;
			const enableString = (enable) ? 'enabled' : 'disabled';
			return 'WPMEM watchpoints are ' + enableString + '.';
		}

		const param = tokens[0] || '';
		if (param=='enable'||param=='disable') {
			// enable or disable all WPMEM watchpoints
			const enable=(param=='enable');
			await  Remote.enableWPMEM(enable)
			return show();  // Print to console
		}
		else if(param == 'status') {
			// just show
			return show();
		}
		else {
			// Unknown argument
			throw new Error("Unknown argument: '" + param + "'");
		}
	}


	/**
	 * Show the sprite patterns in a view.
	 * @param tokens The arguments.
 	 * @returns A Promise<string> with a text to print.
	 */
	protected async evalSpritePatterns(tokens: Array<string>): Promise<string> {
		// First check for tbblue
		if(Remote.machineType != MachineType.TBBLUE)
			throw new Error("Command is available only on tbblue (ZX Next).");
		// Evaluate arguments
		let title;
		let params: Array<number>|undefined = [];
		if(tokens.length == 0) {
			// The view should choose the visible sprites automatically
			title = 'Sprite Patterns: 0-63';
			params.push(0);
			params.push(64);
		}
		else {
			// Create title
			title = 'Sprite Patterns: ' + tokens.join(' ');
			// Get slot and count/endslot
			while(true) {
				// Get parameter
				const param = tokens.shift();
				if(!param)
					break;
				// Evaluate
				const match = /([^+-]*)(([-+])(.*))?/.exec(param);
				if(!match) // Error Handling
					throw new Error("Can't parse: '" + param + "'");
				// start slot
				const start = Utility.parseValue(match[1]);
				if(isNaN(start))	// Error Handling
					throw new Error("Expected slot but got: '" + match[1] + "'");
				// count
				let count = 1;
				if(match[3]) {
					count = Utility.parseValue(match[4]);
					if (isNaN(count))	// Error Handling
						throw new Error("Can't parse: '" + match[4] + "'");
					if(match[3] == "-")	// turn range into count
						count += 1 - start;
				}
				// Check
				if(count <= 0)	// Error Handling
					throw new Error("Not allowed count: '" + match[0] + "'");
				// Add
				params.push(start);
				params.push(count);
			}

			const slotString = tokens[0] || '0';
			const slot = Utility.parseValue(slotString);
			if(isNaN(slot)) {
				// Error Handling: Unknown argument
				throw new Error("Expected slot but got: '" + slotString + "'");
			}
			const countString = tokens[1] || '1';
			const count = Utility.parseValue(countString);
			if(isNaN(count)) {
				// Error Handling: Unknown argument
				throw new Error("Expected count but got: '" + countString + "'");
			}
		}

		// Create new view
		const panel = new ZxNextSpritePatternsView(this, title, params);
		panel.update();

		// Send response
		return 'OK';
	}


	/**
	 * Show the sprites in a view.
	 * @param tokens The arguments.
 	 * @returns A Promise<string> with a text to print.
	 */
	protected async evalSprites(tokens: Array<string>): Promise<string> {
		// First check for tbblue
		if(Remote.machineType != MachineType.TBBLUE)
			throw new Error("Command is available only on tbblue (ZX Next).");
		// Evaluate arguments
		let title;
		let params: Array<number>|undefined;
		if(tokens.length == 0) {
			// The view should choose the visible sprites automatically
			title = 'Visible Sprites';
		}
		else {
			// Create title
			title = 'Sprites: ' + tokens.join(' ');
			// Get slot and count/endslot
			params = [];
			while(true) {
				// Get parameter
				const param = tokens.shift();
				if(!param)
					break;
				// Evaluate
				const match = /([^+-]*)(([-+])(.*))?/.exec(param);
				if(!match) // Error Handling
					throw new Error("Can't parse: '" + param + "'");
				// start slot
				const start = Utility.parseValue(match[1]);
				if(isNaN(start))	// Error Handling
					throw new Error("Expected slot but got: '" + match[1] + "'");
				// count
				let count = 1;
				if(match[3]) {
					count = Utility.parseValue(match[4]);
					if (isNaN(count))	// Error Handling
						throw new Error("Can't parse: '" + match[4] + "'");
					if(match[3] == "-")	// turn range into count
						count += 1 - start;
				}
				// Check
				if(count <= 0)	// Error Handling
					throw new Error("Not allowed count: '" + match[0] + "'");
				// Add
				params.push(start);
				params.push(count);
			}

			const slotString = tokens[0] || '0';
			const slot = Utility.parseValue(slotString);
			if(isNaN(slot)) {
				// Error Handling: Unknown argument
				throw new Error("Expected slot but got: '" + slotString + "'");
			}
			const countString = tokens[1] || '1';
			const count = Utility.parseValue(countString);
			if(isNaN(count)) {
				// Error Handling: Unknown argument
				throw new Error("Expected count but got: '" + countString + "'");
			}
		}

		// Create new view
		const panel = new ZxNextSpritesView(this, title, params);
		panel.update();

		// Send response
		return 'OK';
	}


	/**
	 * Save/restore the state.
	 * @param tokens The arguments. 'save'/'restore'
 	 * @returns A Promise<string> with a text to print.
	 */
	protected async evalStateSaveRestore(tokens: Array<string>): Promise<string> {
		const stateName = tokens[1];
		if(!stateName)
			throw new Error("Parameter missing: You need to add a name for the state, e.g. '0', '1' or more descriptive 'start'");

		const param = tokens[0] || '';
		if(param == 'save') {
			// Save current state
			await this.stateSave(stateName);
			// Send response
			return 'OK';
		}
		else if(param == 'restore') {
			// Restores the state
			await this.stateRestore(stateName);
			// Reload register values etc.
			this.sendEventContinued();
			this.sendEvent(new StoppedEvent('Restore', DebugSessionClass.THREAD_ID));
			return "OK";
		}
		else {
			// Unknown argument
			throw new Error("Unknown argument: '" + param + "'");
		}
	}


	/**
	 * Debug commands. Not shown publicly.
	 * @param tokens The arguments. 'serializer clear'|'serializer print'
 	 * @returns A Promise<string> with a text to print.
	 */
	protected async evalDebug(tokens: Array<string>): Promise<string> {
		const param1 = tokens[0] || '';
		let unknownArg = param1;
		if(param1 == 'serializer') {
			const param2 = tokens[1] || '';
			unknownArg = param2;
			if(param2 == 'clear') {
				// Clear the call serializer queue
				this.serializer.clrQueue();
				return 'OK';
			}
			else if(param2 == 'print') {
				// Print the current function.
				const current = this.serializer.getCurrentFunction();
				const text = 'Progress: ' + current.progress +'\n' +
				'Func: ' + current.func;
				return text;
			}
		}
		// Unknown argument
		throw new Error("Unknown argument: '" + unknownArg + "'");
	}


	/**
	 * Convenience method to send a response for the eval command.
	 * @param text The text to display in the debug console.
	 * @param response The response object.
	 */
	protected sendEvalResponse(text: string, response:DebugProtocol.EvaluateResponse) {
		response.body = { result: text + "\n\n", type: undefined, presentationHint: undefined, variablesReference:0, namedVariables: undefined, indexedVariables: undefined };
		this.sendResponse(response);
	}


    /**
	* Called eg. if user changes a register value.
	*/
	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments) {
		const ref = args.variablesReference;
		const name = args.name;
		const value = Utility.parseValue(args.value);

		// Get variable object
		const varObj=this.listVariables.getObject(ref);
		response.success=false;	// will be changed if successful.
		// Safety check
		if (varObj) {
			// Set value
			const formattedString=await varObj.setValue(name, value);
			// Send response
			if (formattedString) {
				response.body={value: formattedString};
				response.success=true;
			}
		}
		this.sendResponse(response);
	}

	/**
	 * Change the Program Counter such that it points to the given file/line.
	 * @param filename The absolute file path.
	 * @param lineNr The lineNr. Starts at 0.
	 */
	protected setPcToLine(filename: string, lineNr: number) {
		// Get address of file/line
		const realLineNr = lineNr; //this.convertClientLineToDebugger(lineNr);
		const addr = Labels.getAddrForFileAndLine(filename, realLineNr);
		if( addr < 0 )
			return;
		// Now change Program Counter
		Remote.setProgramCounter(addr)
			.then(() => {
				// line is not updated. See https://github.com/Microsoft/vscode/issues/51716
				//this.sendEvent(new StoppedEvent('PC-change', EmulDebugAdapter.THREAD_ID));
				this.sendEventContinued();
				this.sendEvent(new StoppedEvent('PC-change', DebugSessionClass.THREAD_ID));
				// Handle decorations
				Remote.emitRevDbgHistory();
				Remote.handleHistorySpot();
			});
	}


	/**
	 * Called from vscode when the user inputs a command in the command palette.
	 * The method checks if the command is known and executes it.
	 * If the command is unknown the super method is called.
	 * @param command	The command, e.g. 'set-memory'
	 * @param response	Used for responding.
	 * @param args 	The arguments of the command. Usually just 1 text object.
	 */
	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		switch(command) {
			case 'setPcToLine':
				const filename = args[0];
				const lineNr = args[1];
				this.setPcToLine(filename, lineNr);
				break;

			/*
			case 'exec-cmd':
				this.cmdExec(args);
				break;
			case 'set-memory':
				this.cmdSetMemory(args[0]);
				break;
			*/
			default:
				super.customRequest(command, response, args);
				return;
		}
		// send response
		//this.sendResponse(response);
	}


	/**
	 * Called after a step, step-into, run, hit breakpoint, etc.
	 * Is used to update anything that need to updated after some Z80 instructions have been executed.
	 * E.g. the memory dump view.
	 * @param reason The reason is a data object that contains additional information.
	 * E.g. for 'step' it contains { step: true };
	 */
	protected update(reason?: any) {
		this.emit('update', reason);
	}


	/**
	 * Called from "-state save N" command.
	 * Stores all RAM + the registers.
	 * @param stateName A state name (or number) can be appended, so that different states might be saved.
	 */
	protected async stateSave(stateName: string): Promise<void> {
		// Save state
		const stateData=await Remote.stateSave();
		let filePath;
		try {
			// Save data to temp directory
			filePath=Utility.getAbsStateFileName(stateName);
			await stateData.write(filePath);
		}
		catch (e) {
			const errTxt="Can't save '"+filePath+"': "+e.message;
			throw new Error(errTxt);
		}
	}


	/**
	 * Called from "-state restore N" command.
	 * Restores all RAM + the registers from a former "-state save".
	 * @param stateName A state name (or number) can be appended, so that different states might be saved.
	 */
	protected async stateRestore(stateName: string): Promise<void> {
		// Load data from temp directory
		let filePath;
		try {
			// Read data
			filePath=Utility.getAbsStateFileName(stateName);
			const stateData=new StateZX16K();
			await stateData.read(filePath);
			// Restore state
			await Remote.stateRestore(stateData);
		}
		catch (e) {
			const errTxt="Can't load '"+filePath+"': "+e.message;
			throw new Error(errTxt);
		}
	}


	/**
	 * This is a hack:
	 * After starting the vscode sends the source file breakpoints.
	 * But there is no signal to tell when all are sent.
	 * So this function waits as long as there is still traffic to the emulator.
	 * @param timeout Timeout in ms. For this time traffic has to be quiet.
	 * @param handler This handler is called after being quiet for the given timeout.
	 */
	public async executeAfterBeingQuietFor(timeout: number): Promise<void> {
		await Remote.executeAfterBeingQuietFor(timeout);
	}



    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments) {

	}
}


DebugSessionClass.run(DebugSessionClass);
