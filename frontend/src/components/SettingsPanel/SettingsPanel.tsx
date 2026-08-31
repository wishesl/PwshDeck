import './SettingsPanel.css';

type SettingsPanelProps = {
  draggable: boolean;
  busy: boolean;
  error: string;
  onChange: (draggable: boolean) => void;
};

export default function SettingsPanel({ draggable, busy, error, onChange }: SettingsPanelProps) {
  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="settings-section-copy">
          <h2>布局</h2>
          <p>控制终端标签是否可以拖到其他窗口或拆分面板。</p>
        </div>
        <button
          type="button"
          className={`settings-switch ${draggable ? 'on' : ''}`}
          role="switch"
          aria-checked={draggable}
          aria-label="可拖动标签"
          disabled={busy}
          onClick={() => onChange(!draggable)}
        >
          <span />
        </button>
      </section>
      <div className="settings-mode">
        <span className={`settings-mode-dot ${draggable ? 'on' : ''}`} />
        {draggable ? '可拖动：支持多窗口、面板分割和标签拖出' : '固定布局：单窗口，标签仅可在顶部互换位置'}
      </div>
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
