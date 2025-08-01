import { ReactNode } from 'react';

import { IconButton } from '@client:common/buttons';

import './FaultAlertModal.light.scss';
import './FaultAlertModal.dark.scss';

interface Props {
  isOpen: boolean;
  title: string;
  description: string | ReactNode;
  onClose: () => void;
}

export function FaultAlertModal(props: Props) {
  if (!props.isOpen) {
    return null;
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  return (
    <div
      className='fault-alert-modal-backdrop'
      onClick={handleBackdropClick}>
      <div className='fault-alert-modal'>
        <div className='fault-alert-modal__header'>
          <h2 className='fault-alert-modal__title'>{props.title}</h2>
          <IconButton
            className='fault-alert-modal__close-button'
            icon='close'
            size='small'
            onClick={props.onClose}
          />
        </div>
        <div className='fault-alert-modal__body'>
          <div className='fault-alert-modal__description'>
            {typeof props.description === 'string' ? (
              <p>{props.description}</p>
            ) : (
              props.description
            )}
          </div>
        </div>
        <div className='fault-alert-modal__footer'>
          <button
            className='fault-alert-modal__close-btn'
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
