import { useState } from 'react';
import Terminal from './components/Terminal';
import McpPanel from './components/McpPanel';
import { WindowManager } from '../bindings/changeme';
import './App.css';

type Tab = 'terminal' | 'mcp';

export default function App() {
  const [tab, setTab] = useState<Tab>('terminal');

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          pwsh<span className="brand-accent">-mcp</span>
        </div>
        <nav className="tabs">
          <button
            className={`tab ${tab === 'terminal' ? 'active' : ''}`}
            onClick={() => setTab('terminal')}
          >
            终端
          </button>
          <button
            className={`tab ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => setTab('mcp')}
          >
            MCP 管理
          </button>
        </nav>
        <div className="topbar-spacer" />
        <button
          className="new-window-btn"
          onClick={() => WindowManager.NewWindow().catch(() => {})}
          title="打开一个新的终端窗口"
        >
          ＋ 新窗口
        </button>
      </div>
      <main className="content">{tab === 'terminal' ? <Terminal /> : <McpPanel />}</main>
    </div>
  );
}
