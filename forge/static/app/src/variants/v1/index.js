// Variant 1 - Evolution (spark forge-ui-prototypes): the current anatomy with half the noise. Contract:
// src/variants/index.js. CSS is scoped under :root[data-variant="1"].
import './v1.css';
import Inbox from './inbox/Inbox.jsx';
import Reflect from './reflect/Reflect.jsx';
import Panel from './panel/Panel.jsx';

export default {
  name: 'Evolution',
  pages: { inbox: Inbox, reflect: Reflect },
  modules: { 'dowser-evidence': Panel },
};
