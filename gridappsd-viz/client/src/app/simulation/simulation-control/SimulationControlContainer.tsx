import { Component } from 'react';
import { Subject } from 'rxjs';
import { filter, takeUntil, switchMap, tap } from 'rxjs/operators';

import { SimulationManagementService } from '@client:common/simulation';
import { StateStore } from '@client:common/state-store';
import { ModelDictionaryComponent } from '@client:common/topology';
import { PlotModel } from '@client:common/plot-model/PlotModel';
import { SimulationStatus } from '@project:common/SimulationStatus';
import { FaultAlertModal } from '@client:common/overlay/fault-alert-modal/FaultAlertModal';

import { SimulationControl } from './SimulationControl';

interface Props {
  exportSimulationConfiguration: () => void;
}

interface State {
  simulationStatus: SimulationStatus;
  activeSimulationId: string;
  existingPlotModels: PlotModel[];
  modelDictionaryComponents: ModelDictionaryComponent[];
  isCongestionActive: boolean;
  isCongestionModalOpen: boolean;
}

export class SimulationControlContainer extends Component<Props, State> {

  readonly simulationManagementService = SimulationManagementService.getInstance();

  private readonly _stateStore = StateStore.getInstance();
  private readonly _unsubscriber = new Subject<void>();

  constructor(props: Props) {
    super(props);

    this.state = {
      simulationStatus: this.simulationManagementService.currentSimulationStatus(),
      activeSimulationId: '',
      existingPlotModels: [],
      modelDictionaryComponents: [],
      isCongestionActive: false,
      isCongestionModalOpen: false
    };

    this.updatePlotModels = this.updatePlotModels.bind(this);
    this.createCongestion = this.createCongestion.bind(this);
    this.onCloseCongestionModal = this.onCloseCongestionModal.bind(this);
    this.onTakeActionForCongestion = this.onTakeActionForCongestion.bind(this);
  }

  componentDidMount() {
    this._subscribeToSimulationStatusChanges();
    this._subscribeToPlotModelsStateChanges();
    this._subscribeToComponentsWithConsolidatedPhasesStateChanges();
    this._subscribeToSimulationIdChanges();
  }

  private _subscribeToSimulationStatusChanges() {
    this.simulationManagementService.simulationStatusChanges()
      .pipe(
        tap(status => {
          if (this.simulationManagementService.isUserInActiveSimulation()) {
            this.setState({
              simulationStatus: status
            });
          }
        }),
        filter(status => status === SimulationStatus.STARTING),
        switchMap(() => this._stateStore.select('simulationId')),
        filter(simulationId => simulationId !== ''),
        takeUntil(this._unsubscriber)
      )
      .subscribe({
        next: simulationId => {
          this.setState({
            activeSimulationId: simulationId
          });
        }
      });
  }

  private _subscribeToPlotModelsStateChanges() {
    this._stateStore.select('plotModels')
      .pipe(takeUntil(this._unsubscriber))
      .subscribe({
        next: plotModels => this.setState({ existingPlotModels: plotModels })
      });
  }

  private _subscribeToComponentsWithConsolidatedPhasesStateChanges() {
    this._stateStore.select('modelDictionaryComponents')
      .pipe(takeUntil(this._unsubscriber))
      .subscribe({
        next: components => this.setState({ modelDictionaryComponents: components })
      });
  }

  private _subscribeToSimulationIdChanges() {
    this._stateStore.select('simulationId')
      .pipe(takeUntil(this._unsubscriber))
      .subscribe({
        next: id => this.setState({ activeSimulationId: id })
      });
  }

  componentWillUnmount() {
    this._unsubscriber.next();
    this._unsubscriber.complete();
    
    // Clean up any open modals
    if (this.state.isCongestionModalOpen) {
      this.setState({ isCongestionModalOpen: false });
    }
  }

  render() {
    return (
      <>
        <SimulationControl
          simulationId={this.state.activeSimulationId}
          simulationStatus={this.state.simulationStatus}
          existingPlotModels={this.state.existingPlotModels}
          onStartSimulation={this.simulationManagementService.startSimulation}
          onExportSimulationConfiguration={this.props.exportSimulationConfiguration}
          modelDictionaryComponents={this.state.modelDictionaryComponents}
          onStopSimulation={this.simulationManagementService.stopSimulation}
          onPauseSimulation={this.simulationManagementService.pauseSimulation}
          onResumeSimulation={this.simulationManagementService.resumeSimulation}
          onResumeThenPauseSimulation={this.simulationManagementService.resumeThenPauseSimulationAfter}
          onPlotModelCreationDone={this.updatePlotModels}
          onCreateCongestion={this.createCongestion}
          isCongestionActive={this.state.isCongestionActive} />
        
        <FaultAlertModal
          isOpen={this.state.isCongestionModalOpen}
          title='Grid Congestion Detected'
          description={this._getCongestionDescription()}
          onClose={this.onCloseCongestionModal} />
      </>
    );
  }

  updatePlotModels(plotModels: PlotModel[]) {
    this._stateStore.update({
      plotModels
    });
  }

  createCongestion() {
    // eslint-disable-next-line no-console
    console.log('🚨 Creating congestion by opening Switch:sw4...');
    
    // Set congestion as active (disables the button)
    this.setState({ isCongestionActive: true });
    
    // Open Switch:sw4 to create congestion
    this.simulationManagementService.openSwitchSw4();
    
    // Start monitoring for congestion detection
    this._startCongestionMonitoring();
  }

  private _startCongestionMonitoring() {
    // eslint-disable-next-line no-console
    console.log('🔍 Starting congestion monitoring...');
    
    // Subscribe to simulation output measurements for real-time congestion detection
    this.simulationManagementService.simulationOutputMeasurementMapReceived()
      .pipe(
        takeUntil(this._unsubscriber),
        filter(() => this.state.isCongestionActive), // Only monitor when congestion is active
        tap(measurements => this._checkForCongestionIndicators(measurements))
      )
      .subscribe();

    // Fallback timer: Show congestion modal after 4 seconds if no automatic detection
    setTimeout(() => {
      if (this.state.isCongestionActive && !this.state.isCongestionModalOpen) {
        // eslint-disable-next-line no-console
        console.log('⏰ Fallback timer triggered - showing congestion modal');
        this._showCongestionModal();
      }
    }, 8000); // 8 seconds
  }

  private _checkForCongestionIndicators(measurements: Map<string, any>) {
    // Check for voltage = 0 or other congestion indicators
    let congestionDetected = false;
    const affectedEquipment: string[] = [];

    measurements.forEach((measurement) => {
      // Check for zero voltage (indicating disconnected equipment)
      if (measurement.type === 'voltage' && measurement.magnitude === 0) {
        congestionDetected = true;
        affectedEquipment.push(measurement.conductingEquipmentName);
      }
      
      // Check for zero power flow (indicating isolation)
      if (measurement.type === 'power' && measurement.magnitude === 0) {
        congestionDetected = true;
        affectedEquipment.push(measurement.conductingEquipmentName);
      }
    });

    if (congestionDetected && !this.state.isCongestionModalOpen) {
      // eslint-disable-next-line no-console
      console.log('🚨 Real-time congestion detected!', { affectedEquipment });
      this._showCongestionModal();
    }
  }

  private _showCongestionModal() {
    // eslint-disable-next-line no-console
    console.log('🚨 Showing congestion modal...');
    this.setState({ isCongestionModalOpen: true });
  }

  onCloseCongestionModal() {
    this.setState({ isCongestionModalOpen: false });
  }

  onTakeActionForCongestion() {
    // eslint-disable-next-line no-console
    console.log('🔧 Taking action to resolve congestion by closing Switch:sw4...');
    
    // Close Switch:sw4 to resolve congestion
    this.simulationManagementService.closeSwitchSw4();
    
    // Reset congestion state
    this.setState({
      isCongestionActive: false,
      isCongestionModalOpen: false
    });
  }

  private _getCongestionDescription() {
    return (
      <div>
        <p><strong>Critical Grid Congestion Detected</strong></p>
        <p>Opening Switch:sw4 has caused power flow disruption in the distribution network:</p>
        <ul>
          <li><strong>Affected Equipment:</strong> Switch:sw4 (Open)</li>
          <li><strong>Power Flow:</strong> Disrupted on downstream circuits</li>
          <li><strong>Load Impact:</strong> Multiple load points isolated</li>
          <li><strong>Voltage Status:</strong> Zero voltage detected on isolated sections</li>
        </ul>
        <p><strong>Recommended Action:</strong></p>
        <p>Close Switch:sw4 to restore normal power flow and resolve the congestion.</p>
        <button
          className='fault-alert-modal__take-action-btn'
          onClick={this.onTakeActionForCongestion}
          style={{
            backgroundColor: '#28a745',
            color: 'white',
            border: 'none',
            padding: '12px 24px',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
            marginTop: '16px'
          }}>
          Neuragrid Recommendations - Close Switch:sw4
        </button>
      </div>
    );
  }

}
