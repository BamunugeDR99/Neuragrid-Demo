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
  showAIRecommendation: boolean;  // 🆕 New state for AI recommendation timing
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
      isCongestionModalOpen: false,
      showAIRecommendation: false  // 🆕 Start with recommendation hidden
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

    this.setState({
      isCongestionModalOpen: true,
      showAIRecommendation: false  // 🆕 Reset recommendation state
    });

    // 🤖 Simulate AI analysis time - show recommendation after 3 seconds
    setTimeout(() => {
      if (this.state.isCongestionModalOpen) {  // Only show if modal is still open
        this.setState({ showAIRecommendation: true });
      }
    }, 3000);
  }

  onCloseCongestionModal() {
    this.setState({
      isCongestionModalOpen: false,
      showAIRecommendation: false  // 🆕 Reset AI state
    });
  }

  onTakeActionForCongestion() {
    // eslint-disable-next-line no-console
    console.log('🔧 Taking action to resolve congestion by closing Switch:sw4...');
    
    // Close Switch:sw4 to resolve congestion
    this.simulationManagementService.closeSwitchSw4();
    
    // Reset all congestion-related state
    this.setState({
      isCongestionActive: false,
      isCongestionModalOpen: false,
      showAIRecommendation: false  // 🆕 Reset AI state
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
        
        <div
          className='ai-analysis-section'
          style={{
            marginTop: '20px',
            padding: '16px',
            backgroundColor: '#f8f9fa',
            borderRadius: '8px',
            border: '1px solid #e9ecef',
            minHeight: '80px',
            position: 'relative'
          }}>

          {!this.state.showAIRecommendation ? (
            // 🤖 Loading state - show for first 3 seconds
            <div
              className='ai-analysis-loading'
              style={{ textAlign: 'center' }}>
              <div
                className='loading-spinner'
                style={{
                  width: '24px',
                  height: '24px',
                  border: '3px solid #f3f3f3',
                  borderTop: '3px solid #007bff',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  margin: '0 auto 12px auto'
                }}>
              </div>
              <p
                style={{
                  margin: '12px 0 8px 0',
                  fontStyle: 'italic',
                  color: '#6c757d',
                  fontSize: '14px'
                }}>
                Neuragrid AI analyzing grid conditions
              </p>
              <div
                className='loading-dots'
                style={{ display: 'flex', justifyContent: 'center', gap: '4px' }}>
                <span style={{
                  width: '6px',
                  height: '6px',
                  backgroundColor: '#007bff',
                  borderRadius: '50%',
                  animation: 'loadingDot1 1.4s ease-in-out infinite both'
                }}></span>
                <span style={{
                  width: '6px',
                  height: '6px',
                  backgroundColor: '#007bff',
                  borderRadius: '50%',
                  animation: 'loadingDot2 1.4s ease-in-out infinite both'
                }}></span>
                <span style={{
                  width: '6px',
                  height: '6px',
                  backgroundColor: '#007bff',
                  borderRadius: '50%',
                  animation: 'loadingDot3 1.4s ease-in-out infinite both'
                }}></span>
              </div>
            </div>
          ) : (
            // ✅ Recommendation state - show after 3 seconds
            <div
              className='ai-recommendation-container'
              style={{
                animation: 'fadeInRecommendation 0.5s ease-in'
              }}>
              <p
                className='ai-recommendation-title'
                style={{ margin: '0 0 8px 0' }}>
                <strong>Neuragrid Recommended Action:</strong>
              </p>
              <p
                style={{
                  margin: '0 0 16px 0',
                  fontSize: '14px',
                  color: '#495057'
                }}>
                Neuragrid AI has identified the following actions to resolve the congestion:
                <br />
                1. Implement Topology Update – Reconfigure switch SW4 to re-establish continuity on the downstream circuit
                <br />
                2. Execute Restoration Plan – Reconnect subsequent substations
              </p>
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
                  width: '100%',
                  fontSize: '14px',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 2px 4px rgba(40, 167, 69, 0.2)'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#218838';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 4px 8px rgba(40, 167, 69, 0.3)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#28a745';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 4px rgba(40, 167, 69, 0.2)';
                }}>
                Take Recommended Action
              </button>
            </div>
          )}
        </div>
        
        {/* 🎨 Add CSS animations */}
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          @keyframes loadingDot1 {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
          }
          
          @keyframes loadingDot2 {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
          }
          
          @keyframes loadingDot3 {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
          }
          
          @keyframes fadeInRecommendation {
            0% { 
              opacity: 0; 
              transform: translateY(10px); 
            }
            100% { 
              opacity: 1; 
              transform: translateY(0); 
            }
          }
          
          .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
          .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
          .loading-dots span:nth-child(3) { animation-delay: 0s; }
          
          /* Override modal's white text for our AI recommendation */
          .ai-recommendation-title,
          .ai-recommendation-title strong {
            color: #000000 !important;
          }
          
          .ai-recommendation-container p {
            color: #495057 !important;
          }
          
          .ai-recommendation-container .ai-recommendation-title,
          .ai-recommendation-container .ai-recommendation-title strong {
            color: #000000 !important;
          }
        `}</style>
      </div>
    );
  }

}
