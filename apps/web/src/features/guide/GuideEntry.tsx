import markdown from '../../../../../docs/user-guide.md?raw';
import {GuideDialog} from './GuideDialog';
import './GuideDialog.css';

export function GuideEntry({onClose}: {onClose: () => void}) {
  return <GuideDialog markdown={markdown} onClose={onClose}/>;
}
