import { useState } from 'react';
import './App.css';
import { PdfViewer } from './components/PdfViewer';
import { PdfComparator } from './components/PdfComparator';
import { PdfTools } from './components/tools/PdfTools';
import { PdfTextifier } from './components/PdfTextifier';
import { PdfSplitMerge } from './components/PdfSplitMerge';
import { HowToUse } from './components/HowToUse';

function App() {
  const [mode, setMode] = useState<'annotate' | 'compare' | 'tools' | 'textify' | 'split-merge' | 'usage'>('usage');

  return (
    <div className="app-container">
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 20px',
        backgroundColor: '#333',
        color: 'white'
      }}>
        <h1 style={{ fontSize: '1.6em', margin: 0 }}>建築設計お役立ちPDFツール集</h1>
        <nav style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => setMode('usage')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'usage' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            使い方
          </button>
          <button
            onClick={() => setMode('annotate')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'annotate' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            PDF加筆
          </button>
          <button
            onClick={() => setMode('compare')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'compare' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            PDF比較
          </button>
          <button
            onClick={() => setMode('tools')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'tools' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            PDF加工
          </button>
          <button
            onClick={() => setMode('split-merge')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'split-merge' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            PDF抽出・統合
          </button>
          <button
            onClick={() => setMode('textify')}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: mode === 'textify' ? '#4a90e2' : '#555',
              color: 'white',
              cursor: 'pointer'
            }}
          >
            PDFテキスト化
          </button>
        </nav>
      </header>

      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {mode === 'annotate' && <PdfViewer />}
        {mode === 'compare' && <PdfComparator />}
        {mode === 'tools' && <PdfTools />}
        {mode === 'textify' && <PdfTextifier />}
        {mode === 'split-merge' && <PdfSplitMerge />}
        {mode === 'usage' && <HowToUse />}
      </main>
    </div>
  );
}

export default App;
