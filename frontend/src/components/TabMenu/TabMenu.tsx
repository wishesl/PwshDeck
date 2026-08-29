import { useEffect, useRef, useState } from 'react';
import './TabMenu.css';

/** Accent palette offered by the tab context menu. */
export const TAB_COLORS: { name: string; value: string }[] = [
  { name: '默认蓝', value: '#4f8cff' },
  { name: '翠绿', value: '#3fb950' },
  { name: '青色', value: '#39c5cf' },
  { name: '紫色', value: '#bc8cff' },
  { name: '粉色', value: '#f778ba' },
  { name: '橙色', value: '#ff9f43' },
  { name: '金黄', value: '#e3b341' },
  { name: '红色', value: '#f85149' },
  { name: '白色', value: '#e6edf3' },
];

interface TabMenuProps {
  x: number;
  y: number;
  title: string;
  accent: string;
  onRename: (name: string) => void;
  onAccent: (color: string) => void;
  onClose: () => void;
}

export default function TabMenu({ x, y, title, accent, onRename, onAccent, onClose }: TabMenuProps) {
  const [name, setName] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onRename(trimmed);
    } else {
      onClose(); // empty name: treat as cancel
    }
  };

  // Keep the menu inside the viewport.
  const style = {
    left: Math.max(4, Math.min(x, window.innerWidth - 236)),
    top: Math.max(4, Math.min(y, window.innerHeight - 172)),
  };

  return (
    <>
      <div
        className="tab-menu-overlay"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="tab-menu" style={style}>
        <div className="tab-menu-section">
          <label>名称</label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="tab-menu-section">
          <label>颜色</label>
          <div className="tab-colors">
            {TAB_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`tab-color ${c.value === accent ? 'selected' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                onClick={() => onAccent(c.value)}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
