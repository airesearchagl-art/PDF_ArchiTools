import React from 'react';

interface VersionFooterProps {
    toolName: 'annotator' | 'comparator' | 'tools' | 'textifier' | 'splitMerge';
    version: string;
    lastUpdate: string;
}

export const VersionFooter: React.FC<VersionFooterProps> = ({ version, lastUpdate }) => {
    return (
        <footer style={{
            padding: '8px 16px',
            backgroundColor: '#2a2a2a',
            color: '#888',
            fontSize: '0.75rem',
            textAlign: 'center',
            borderTop: '1px solid #444',
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 100
        }}>
            Version {version} | Last Update: {lastUpdate}
        </footer>
    );
};
