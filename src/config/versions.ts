/**
 * ツール別バージョン管理
 * 
 * セマンティックバージョニング: MAJOR.MINOR.PATCH
 * - PATCH (末尾): 小さな変更・バグ修正 (確認不要)
 * - MINOR (中間): 大きな機能追加・変更 (確認必要)
 * - MAJOR (先頭): 抜本的な見直し・破壊的変更 (確認必要)
 */

export interface ToolVersion {
    version: string;
    lastUpdate: string; // YYYY/MM/DD形式
    changelog?: string; // 最新の変更内容
}

export const TOOL_VERSIONS: Record<string, ToolVersion> = {
    annotator: {
        version: '1.1.1',
        lastUpdate: '2026/01/29',
        changelog: '初期リリース'
    },
    comparator: {
        version: '1.1.1',
        lastUpdate: '2026/01/29',
        changelog: '初期リリース'
    },
    tools: {
        version: '1.1.1',
        lastUpdate: '2026/01/29',
        changelog: '初期リリース'
    },
    textifier: {
        version: '1.1.1',
        lastUpdate: '2026/01/29',
        changelog: '初期リリース'
    },
    splitMerge: {
        version: '1.1.1',
        lastUpdate: '2026/01/29',
        changelog: '初期リリース'
    }
};

// アプリ全体のバージョン（package.jsonと同期）
export const APP_VERSION = '1.1.1';
