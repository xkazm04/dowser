// Variant 2 - Quiet editorial (spark forge-ui-prototypes). Contract: src/variants/index.js. CSS is scoped under :root[data-variant="2"].
import './v2.css';
import Inbox from './inbox/Inbox.jsx';
import Reflect from './reflect/Reflect.jsx';
import Panel from './panel/Panel.jsx';

export default {
  name: 'Quiet editorial',
  pages: { inbox: Inbox, reflect: Reflect },
  modules: { 'dowser-evidence': Panel },
};
