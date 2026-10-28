// Variant 3 - Reading pane (spark forge-ui-prototypes). A dense queue list plus a reading pane for the inbox, a
// digest-first Learning page, and a single-column evidence panel. Contract: src/variants/index.js. CSS is scoped
// under :root[data-variant="3"]. Map and Settings fall back to the current pages (restyled by v3.css only).
import './v3.css';
import './learn.css';
import Inbox from './inbox/Inbox.jsx';
import Reflect from './reflect/Reflect.jsx';
import Panel from './Panel.jsx';

export default {
  name: 'Reading pane',
  pages: { inbox: Inbox, reflect: Reflect },
  modules: { 'dowser-evidence': Panel },
};
