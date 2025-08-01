import { Subject, Observable, Subscription, BehaviorSubject, timer } from 'rxjs';
import { filter, pluck, debounce, takeWhile, switchMap } from 'rxjs/operators';
import { io } from 'socket.io-client';
import * as React from 'react';

import { StompClientService, StompClientConnectionStatus } from '@client:common/StompClientService';
import { SimulationStatus } from '@project:common/SimulationStatus';
import { SimulationSnapshot, DEFAULT_SIMULATION_SNAPSHOT } from '@project:common/SimulationSnapshot';
import { SimulationSynchronizationEvent } from '@project:common/SimulationSynchronizationEvent';
import { ModelDictionaryMeasurement } from '@client:common/topology';
import { StateStore } from '@client:common/state-store';
import { ConductingEquipmentType } from '@client:common/topology/model-dictionary';
import { DateTimeService } from '@client:common/DateTimeService';

import { Simulation } from './Simulation';
import { SimulationStatusLogMessage } from './SimulationStatusLogMessage';
import { SimulationQueue } from './SimulationQueue';
import { START_SIMULATION_TOPIC, CONTROL_SIMULATION_TOPIC, SIMULATION_OUTPUT_TOPIC, SIMULATION_STATUS_LOG_TOPIC } from './topics';
import { SimulationConfiguration } from './SimulationConfiguration';

import { SimulationOutputMeasurement, SimulationOutputPayload } from '.';

interface SimulationStartedEventResponse {
  simulationId: string;
  events: Array<{
    allOutputOutage: boolean;
    allInputOutage: boolean;
    inputOutageList: Array<{ objectMRID: string; attribute: string }>;
    outputOutageList: string[];
    faultMRID: string;
    // eslint-disable-next-line camelcase
    event_type: string;
    occuredDateTime: number;
    stopDateTime: number;
    PhaseConnectedFaultKind: string;
    phases: string;
  }>;
}

/**
 * This class is responsible for communicating with the platform to process the simulation.
 * Simulation is started when the play button is clicked
 */
export class SimulationManagementService {

  private static readonly _INSTANCE_: SimulationManagementService = new SimulationManagementService();

  private readonly _simulationQueue = SimulationQueue.getInstance();
  private readonly _stateStore = StateStore.getInstance();
  private readonly _stompClientService = StompClientService.getInstance();
  private readonly _currentSimulationStatusNotifer = new BehaviorSubject<SimulationStatus>(SimulationStatus.STOPPED);
  private readonly _socket = io();
  private readonly _simulationSnapshot: SimulationSnapshot = DEFAULT_SIMULATION_SNAPSHOT;
  private readonly _simulationSnapshotReceivedNotifier = new BehaviorSubject<SimulationSnapshot>({} as SimulationSnapshot);
  private readonly _simulationOutputMeasurementMapStream = new Subject<Map<string, SimulationOutputMeasurement>>();

  private _currentSimulationStatus = SimulationStatus.STOPPED;
  private _didUserStartActiveSimulation = false;
  private _isUserInActiveSimulation = false;
  private _modelDictionaryMeasurementMap: Map<string, ModelDictionaryMeasurement> = null;
  private _outputTimestamp: number;
  private _simulationOutputSubscription: Subscription = null;
  private _simulationStatusLogStreamSubscription: Subscription;
  private _currentSimulationId = '';
  private _syncingEnabled = false;

  static getInstance(): SimulationManagementService {
    return SimulationManagementService._INSTANCE_;
  }

  private constructor() {

    this._onActiveSimulationIdsReceived();
    this._onSimulationStatusChangedUpstream();
    this._onSendFirstSimulationSnapshot();
    this._onSimulationSnapshotReceived();
    this._watchStompClientStatusChanges();
    this._onActiveSimulationSnapshotStateReceived();
    this._onSimulationOutputSnapshotStateReceived();

    this.startSimulation = this.startSimulation.bind(this);
    this.stopSimulation = this.stopSimulation.bind(this);
    this.pauseSimulation = this.pauseSimulation.bind(this);
    this.resumeSimulation = this.resumeSimulation.bind(this);
    this.requestToJoinActiveSimulation = this.requestToJoinActiveSimulation.bind(this);
    this.isUserInActiveSimulation = this.isUserInActiveSimulation.bind(this);
    this.resumeThenPauseSimulationAfter = this.resumeThenPauseSimulationAfter.bind(this);
    this.openSwitch = this.openSwitch.bind(this);
    this.closeSwitch = this.closeSwitch.bind(this);
    this.openSwitchSw4 = this.openSwitchSw4.bind(this);
    this.closeSwitchSw4 = this.closeSwitchSw4.bind(this);
  }

  /**
   * Because the user can join simulations started by someone else, we check the server here to see
   * if there are any existing simulations currently
   */
  private _onActiveSimulationIdsReceived() {
    this._socket.on(SimulationSynchronizationEvent.QUERY_ACTIVE_SIMULATION_CHANNELS, (activeSimulationIds: string[]) => {
      this._stateStore.update({
        activeSimulationIds: activeSimulationIds.filter(e => e !== this._currentSimulationId)
      });
    });
  }

  /**
   * Check if the current simulation that this user is in had its simulation status updated
   * by someone else
   */
  private _onSimulationStatusChangedUpstream() {
    this._socket.on(SimulationSynchronizationEvent.QUERY_SIMULATION_STATUS, (status: SimulationStatus) => {
      this._currentSimulationStatus = status;
      this._currentSimulationStatusNotifer.next(status);
      if (status === SimulationStatus.STOPPED) {
        this._isUserInActiveSimulation = false;
      }
    });
  }

  /**
   * When some other user requests to join a currently running simulation, we want to sync the current
   * state of the simulation when that other user joins so that they can see the state of the simulation
   * up until that point
   */
  private _onSendFirstSimulationSnapshot() {
    this._socket.on(SimulationSynchronizationEvent.INIT_SIMULATION_SNAPSHOT, () => {
      this._syncingEnabled = true;
      this._simulationSnapshot.stateStore = this._stateStore.toJson();
      this._simulationSnapshot.activeSimulation = this._simulationQueue.getActiveSimulation();
      this._socket.emit(SimulationSynchronizationEvent.INIT_SIMULATION_SNAPSHOT, this._simulationSnapshot);
    });
  }

  /**
   * Watch for new simulation snapshots. When the user joins a simulation, if there is new update to simulation
   * states, they are packaged into a snapshot and are then broadcast to every simulation participant over websocket
   */
  private _onSimulationSnapshotReceived() {
    this._socket.on(SimulationSynchronizationEvent.RECEIVE_SIMULATION_SNAPSHOT, (snapshot: SimulationSnapshot) => {
      this._simulationSnapshotReceivedNotifier.next(snapshot);
    });
  }

  private _watchStompClientStatusChanges() {
    return this._stompClientService.statusChanges()
      .pipe(filter(status => status === StompClientConnectionStatus.CONNECTED))
      .subscribe({
        next: () => {
          if (this._simulationOutputSubscription !== null) {
            this._simulationOutputSubscription.unsubscribe();
            this._simulationOutputSubscription = null;
            this.stopSimulation();
          }
        }
      });
  }

  /**
   * If there is a change in the current `activeSimulation` object,
   * then we want to retrieve it and store it into the queue of existing simulations
   */
  private _onActiveSimulationSnapshotStateReceived() {
    this.selectSimulationSnapshotState('activeSimulation')
      .pipe(filter(value => value !== null))
      .subscribe({
        next: (activeSimulation: Simulation) => this._simulationQueue.push(activeSimulation)
      });
  }

  /**
   * Get the simulation output from the simulation snapshot
   */
  private _onSimulationOutputSnapshotStateReceived() {
    this.selectSimulationSnapshotState('simulationOutput')
      .pipe(
        filter(value => value !== null),
        debounce(() => timer(0, 16).pipe(takeWhile(() => this._modelDictionaryMeasurementMap === null)))
      )
      .subscribe({
        next: (simulationOutput: SimulationOutputPayload) => this._broadcastSimulationOutputMeasurements(simulationOutput)
      });
  }

  selectSimulationSnapshotState<K extends keyof SimulationSnapshot>(key: K): Observable<SimulationSnapshot[K]> {
    return this._simulationSnapshotReceivedNotifier.asObservable()
      .pipe(
        filter(snapshot => key in snapshot),
        pluck(key)
      );
  }

  requestToJoinActiveSimulation(simulationId: string) {
    this._isUserInActiveSimulation = true;
    this._socket.emit(SimulationSynchronizationEvent.JOIN_SIMULATION, simulationId);
  }

  didUserStartActiveSimulation() {
    return this._didUserStartActiveSimulation;
  }

  isUserInActiveSimulation() {
    return this._isUserInActiveSimulation;
  }

  getOutputTimestamp() {
    return this._outputTimestamp;
  }

  updateModelDictionaryMeasurementMap(newMap: Map<string, ModelDictionaryMeasurement>) {
    this._modelDictionaryMeasurementMap = newMap;
  }

  simulationOutputMeasurementMapReceived(): Observable<Map<string, SimulationOutputMeasurement>> {
    return this._simulationOutputMeasurementMapStream.asObservable();
  }

  syncSimulationSnapshotState<K extends keyof SimulationSnapshot>(state: Pick<SimulationSnapshot, K>) {
    for (const entry of Object.entries(state)) {
      (this._simulationSnapshot as any)[entry[0]] = entry[1];
    }
    if (this._syncingEnabled) {
      this._socket.emit(SimulationSynchronizationEvent.RECEIVE_SIMULATION_SNAPSHOT, state);
    }
  }

  simulationStatusChanges(): Observable<SimulationStatus> {
    return this._currentSimulationStatusNotifer.asObservable();
  }

  currentSimulationStatus() {
    return this._currentSimulationStatus;
  }

  startSimulation() {
    // 1. Initial Guard Condition - Prevents starting a simulation if one is already running or starting
    // Ensures only one simulation can be active at a time
    if (this._currentSimulationStatus !== SimulationStatus.STARTED && this._currentSimulationStatus !== SimulationStatus.STARTING) {
      // 2. Configuration Preparation
      const activeSimulation = this._simulationQueue.getActiveSimulation(); // Retrieves the active simulation from the queue
      const simulationConfig = activeSimulation.config; // Extracts its configuration
      const startTime = DateTimeService.getInstance().parse(simulationConfig.simulation_config.start_time); // Parses the start time using the DateTimeService to ensure proper formatting


      // 3. Configuration Normalization
      // Retrieves the active simulation from the queue
      // Extracts its configuration
      // Parses the start time using the DateTimeService to ensure proper formatting
      // Creates a new configuration object with the parsed start time converted to string
      // Uses spread operator to preserve all other configuration properties
      const config: SimulationConfiguration = {
        ...simulationConfig,
        // eslint-disable-next-line camelcase
        simulation_config: {
          ...simulationConfig.simulation_config,
          // eslint-disable-next-line camelcase
          start_time: String(startTime)
        }
      };
      // 4. State Management
      // Marks the simulation as having been run
      // Sets flags indicating this user initiated and is participating in the simulation
      // Updates status to STARTING and notifies observers
      activeSimulation.didRun = true;
      this._didUserStartActiveSimulation = true;
      this._isUserInActiveSimulation = true;
      this._currentSimulationStatus = SimulationStatus.STARTING;
      this._currentSimulationStatusNotifer.next(SimulationStatus.STARTING);

      // 5. Subscription Setup
      // Sets up output subscription only if not already active
      // Subscribes to simulation start events
      // Monitors simulation process status through log stream
      if (!this._simulationOutputSubscription) {
        this._simulationOutputSubscription = this._subscribeToSimulationOutputTopic();
      }
      this._subscribeToStartSimulationTopic();
      this._readSimulationProcessStatusFromSimulationLogStream();

      // 6. State Synchronization
      // Reset this state
      // Resets simulation output state for a clean start
      // Synchronizes this state across all simulation participants
      this.syncSimulationSnapshotState({
        simulationOutput: null
      });

      // 7. Delayed Command Execution
      // Let's wait for all the subscriptions in other components to this topic to complete
      // before sending the message
      // Waits 1 second before sending the start command
      // Ensures all subscription setups in other components are complete
      // Sends the configuration to the GridApps-D platform via STOMP messaging
      setTimeout(() => {
        this._stompClientService.send({
          destination: START_SIMULATION_TOPIC,
          replyTo: START_SIMULATION_TOPIC,
          body: JSON.stringify(config)
        });
      }, 1000);
    }
  }

  private _subscribeToSimulationOutputTopic() {

    // STOMP Client Integration
    return this._stompClientService.readFrom<SimulationOutputPayload>(SIMULATION_OUTPUT_TOPIC)
      .pipe(
        filter(
          payload => (this._currentSimulationStatus === SimulationStatus.STARTED || this._currentSimulationStatus === SimulationStatus.RESUMED) && Boolean(payload)
        )
      )
      .subscribe({
        next: payload => {
          if (this._syncingEnabled) {
            this.syncSimulationSnapshotState({
              simulationOutput: payload
            });
          }
          this._broadcastSimulationOutputMeasurements(payload);
        }
      });
  }

  private _broadcastSimulationOutputMeasurements(payload: SimulationOutputPayload) {
    this._outputTimestamp = payload.message.timestamp;
    const measurementMap = new Map<string, SimulationOutputMeasurement>();
    for (const [mrid, rawSimulationOutputMeasurement] of Object.entries(payload.message.measurements)) {
      const measurementInModelDictionary = this._modelDictionaryMeasurementMap.get(mrid);
      if (measurementInModelDictionary) {
        const measurement: SimulationOutputMeasurement = {
          name: measurementInModelDictionary.name,
          type: measurementInModelDictionary.measurementType,
          magnitude: rawSimulationOutputMeasurement.magnitude,
          angle: rawSimulationOutputMeasurement.angle,
          value: rawSimulationOutputMeasurement.value,
          mRID: rawSimulationOutputMeasurement.measurement_mrid,
          phases: measurementInModelDictionary.phases,
          conductingEquipmentName: measurementInModelDictionary.ConductingEquipment_name,
          conductingEquipmentType: measurementInModelDictionary.ConductingEquipment_type as ConductingEquipmentType,
          connectivityNode: measurementInModelDictionary.ConnectivityNode,
          conductingEquipmentMRID: measurementInModelDictionary.ConductingEquipment_mRID
        };
        measurementMap.set(mrid, measurement);
        // measurementMap.set(measurementInModelDictionary.ConductingEquipment_name, measurement);
        // measurementMap.set(measurementInModelDictionary.ConnectivityNode, measurement);
      }
    }
    this._simulationOutputMeasurementMapStream.next(measurementMap);
  }

  private _subscribeToStartSimulationTopic() {
    this._stompClientService.readOnceFrom<SimulationStartedEventResponse>(START_SIMULATION_TOPIC)
      .subscribe({
        next: payload => {
          this._currentSimulationId = payload.simulationId;
          this._simulationQueue.updateIdOfActiveSimulation(payload.simulationId);
          this._stateStore.update({
            simulationId: payload.simulationId,
            faultMRIDs: payload.events.map(event => event.faultMRID)
          });
        }
      });
  }

  private _readSimulationProcessStatusFromSimulationLogStream() {
    this._simulationStatusLogStreamSubscription = this._stateStore.select('simulationId')
      .pipe(
        filter(simulationId => simulationId !== ''),
        switchMap(id => this._stompClientService.readFrom<SimulationStatusLogMessage>(`${SIMULATION_STATUS_LOG_TOPIC}.${id}`)),
        takeWhile(message => message.processStatus !== 'COMPLETE')
      )
      .subscribe({
        next: message => {
          if (message.processStatus === 'STARTED') {
            this._updateSimulationStatus(SimulationStatus.STARTED);
          } else if (message.processStatus === 'PAUSED') {
            this._updateSimulationStatus(SimulationStatus.PAUSED);
          }
        },
        complete: this.stopSimulation
      });
  }

  private _updateSimulationStatus(newStatus: SimulationStatus) {
    this._currentSimulationStatus = newStatus;
    this._currentSimulationStatusNotifer.next(newStatus);
    this._socket.emit(
      SimulationSynchronizationEvent.QUERY_SIMULATION_STATUS,
      {
        status: newStatus,
        simulationId: this._currentSimulationId
      }
    );
  }

  stopSimulation() {
    if (this._didUserStartActiveSimulation) {
      this._updateSimulationStatus(SimulationStatus.STOPPED);
      this._simulationStatusLogStreamSubscription.unsubscribe();
      this._sendSimulationControlCommand('stop');
      this._didUserStartActiveSimulation = false;
      this._isUserInActiveSimulation = false;
      this._syncingEnabled = false;
    }
  }

  pauseSimulation() {
    this._sendSimulationControlCommand('pause');
  }

  resumeSimulation() {
    this._updateSimulationStatus(SimulationStatus.RESUMED);
    this._sendSimulationControlCommand('resume');
  }

  private _sendSimulationControlCommand(command: 'stop' | 'pause' | 'resume') {
    this._stompClientService.send({
      destination: `${CONTROL_SIMULATION_TOPIC}.${this._currentSimulationId}`,
      body: `{"command":"${command}"}`
    });
  }

  resumeThenPauseSimulationAfter(seconds: number) {
    this._updateSimulationStatus(SimulationStatus.RESUMED);
    setTimeout(() => {
      this._updateSimulationStatus(SimulationStatus.PAUSED);
    }, seconds * 1000);
    this._stompClientService.send({
      destination: `${CONTROL_SIMULATION_TOPIC}.${this._currentSimulationId}`,
      body: JSON.stringify({
        command: 'resumePauseAt',
        input: {
          pauseIn: seconds
        }
      })
    });
  }

  /**
   * Opens the first available switch or specified switch
   *
   * @param switchMRIDOrEvent - The switch MRID to control or React event (when called from UI)
   */
  openSwitch(switchMRIDOrEvent: string | React.MouseEvent = '') {
    // If called with a specific MRID, use it directly
    if (typeof switchMRIDOrEvent === 'string' && switchMRIDOrEvent) {
      this._sendSwitchControlCommand(switchMRIDOrEvent, true);
      return;
    }

    // Get the first available switch from model dictionary (this worked before!)
    const switchMRID = this._getFirstAvailableSwitch();
    if (switchMRID) {
      this._sendSwitchControlCommand(switchMRID, true);
    } else {
      // eslint-disable-next-line no-console
      console.warn('No switches available in current simulation model');
    }
  }

  /**
   * Closes the first available switch or specified switch
   *
   * @param switchMRIDOrEvent - The switch MRID to control or React event (when called from UI)
   */
  closeSwitch(switchMRIDOrEvent: string | React.MouseEvent = '') {
    // If called with a specific MRID, use it directly
    if (typeof switchMRIDOrEvent === 'string' && switchMRIDOrEvent) {
      this._sendSwitchControlCommand(switchMRIDOrEvent, false);
      return;
    }

    // Get the first available switch from model dictionary (this worked before!)
    const switchMRID = this._getFirstAvailableSwitch();
    if (switchMRID) {
      this._sendSwitchControlCommand(switchMRID, false);
    } else {
      // eslint-disable-next-line no-console
      console.warn('No switches available in current simulation model');
    }
  }

  /**
   * Specifically opens Switch:sw4 by name (synchronous version for UI buttons)
   * This is what you wanted - direct control of Switch:sw4
   */
  openSwitchSw4(): void {
    // eslint-disable-next-line no-console
    console.log('🔴 Open Switch:sw4 button clicked!');
    
    // Log all available switches first
    this._logAllAvailableSwitches();
    
    // Try to find sw4 specifically, otherwise use first available
    const sw4MRID = this._findSwitchByName('sw4');
    if (sw4MRID) {
      // eslint-disable-next-line no-console
      console.log('✅ Found sw4, opening it...');
      this._sendSwitchControlCommand(sw4MRID, true);
    } else {
      // eslint-disable-next-line no-console
      console.log('❌ sw4 not found, opening first available switch...');
      this.openSwitch();
    }
  }

  /**
   * Specifically closes Switch:sw4 by name (synchronous version for UI buttons)
   * This is what you wanted - direct control of Switch:sw4
   */
  closeSwitchSw4(): void {
    // eslint-disable-next-line no-console
    console.log('🟢 Close Switch:sw4 button clicked!');
    
    // Log all available switches first
    this._logAllAvailableSwitches();
    
    // Try to find sw4 specifically, otherwise use first available
    const sw4MRID = this._findSwitchByName('sw4');
    if (sw4MRID) {
      // eslint-disable-next-line no-console
      console.log('✅ Found sw4, closing it...');
      this._sendSwitchControlCommand(sw4MRID, false);
    } else {
      // eslint-disable-next-line no-console
      console.log('❌ sw4 not found, closing first available switch...');
      this.closeSwitch();
    }
  }

  /**
   * Gets the first available switch MRID from the current simulation model
   */
  private _getFirstAvailableSwitch(): string | null {
    try {
      const stateStoreData = this._stateStore.toJson() as any;
      const modelDictionary = stateStoreData.modelDictionary;
      
      if (modelDictionary && modelDictionary.switches && modelDictionary.switches.length > 0) {
        const firstSwitch = modelDictionary.switches[0];
        // eslint-disable-next-line no-console
        console.log(`✅ Using first available switch: ${firstSwitch.name} (${firstSwitch.mRID})`);
        return firstSwitch.mRID;
      }
      
      // eslint-disable-next-line no-console
      console.warn('❌ No switches found in model dictionary');
      return null;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error getting available switches:', error);
      return null;
    }
  }

  /**
   * Logs all available switches with their names and MRIDs for debugging
   */
  private _logAllAvailableSwitches(): void {
    try {
      const stateStoreData = this._stateStore.toJson() as any;
      const modelDictionary = stateStoreData.modelDictionary;
      
      if (modelDictionary && modelDictionary.switches && modelDictionary.switches.length > 0) {
        // eslint-disable-next-line no-console
        console.log('📋 All available switches in model:');
        modelDictionary.switches.forEach((s: any, index: number) => {
          // eslint-disable-next-line no-console
          console.log(`  ${index + 1}. Name: "${s.name}", mRID: "${s.mRID}", Phases: "${s.phases}", Open: ${s.open}`);
        });
      } else {
        // eslint-disable-next-line no-console
        console.warn('❌ No switches found in model dictionary');
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error logging available switches:', error);
    }
  }

  /**
   * Finds a switch by name in the model dictionary
   * This works with the switch data format you showed me
   */
  private _findSwitchByName(switchName: string): string | null {
    try {
      const stateStoreData = this._stateStore.toJson() as any;
      const modelDictionary = stateStoreData.modelDictionary;
      
      if (modelDictionary && modelDictionary.switches && modelDictionary.switches.length > 0) {
        // Look for exact name match first
        const exactMatch = modelDictionary.switches.find((s: any) => s.name === switchName);
        if (exactMatch) {
          // eslint-disable-next-line no-console
          console.log(`✅ Found exact match for "${switchName}": mRID = "${exactMatch.mRID}"`);
          return exactMatch.mRID;
        }
        
        // Look for partial name match
        const partialMatch = modelDictionary.switches.find((s: any) => s.name.includes(switchName));
        if (partialMatch) {
          // eslint-disable-next-line no-console
          console.log(`✅ Found partial match for "${switchName}": "${partialMatch.name}", mRID = "${partialMatch.mRID}"`);
          return partialMatch.mRID;
        }
        
        // eslint-disable-next-line no-console
        console.warn(`❌ Switch "${switchName}" not found in model dictionary`);
      }
      
      return null;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error finding switch by name:', error);
      return null;
    }
  }

  private _sendSwitchControlCommand(switchMRID: string, open: boolean) {
    if (this._currentSimulationStatus !== SimulationStatus.STARTED &&
        this._currentSimulationStatus !== SimulationStatus.RESUMED) {
      // eslint-disable-next-line no-console
      console.warn('Cannot control switch: simulation is not running');
      return;
    }

    // Get the proper difference MRID from the active simulation configuration
    const activeSimulation = this._simulationQueue.getActiveSimulation();
    const differenceMRID = activeSimulation?.config?.power_system_config?.Line_name || switchMRID;

    const switchControlMessage = {
      command: 'update',
      input: {
        // eslint-disable-next-line camelcase
        simulation_id: this._currentSimulationId,
        message: {
          timestamp: Math.floor(Date.now() / 1000.0),
          // eslint-disable-next-line camelcase
          difference_mrid: differenceMRID,
          // eslint-disable-next-line camelcase
          reverse_differences: [
            {
              object: switchMRID,
              value: open ? 0 : 1,
              attribute: 'Switch.open'
            }
          ],
          // eslint-disable-next-line camelcase
          forward_differences: [
            {
              object: switchMRID,
              value: open ? 1 : 0,
              attribute: 'Switch.open'
            }
          ]
        }
      }
    };

    this._stompClientService.send({
      destination: `${CONTROL_SIMULATION_TOPIC}.${this._currentSimulationId}`,
      body: JSON.stringify(switchControlMessage)
    });

    // eslint-disable-next-line no-console
    console.log(`Sent command to ${open ? 'open' : 'close'} switch ${switchMRID} using difference MRID: ${differenceMRID}`);
  }

}
