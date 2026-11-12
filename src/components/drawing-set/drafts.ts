import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * What a person has typed but not yet recorded -- the rows of a register being
 * declared, a row being corrected, a Decision's outcome and comment -- and how
 * far the Finding lists were opened. The workspace keeps one book for the
 * session. Switching between ページ表示 and QA・図面一覧 takes one view off the
 * screen and puts the other on, so a panel asks the book for what it held when
 * it is shown again. Screen state only: never part of the Drawing Set, never
 * saved, gone with the session.
 */
export class DraftBook {
    private readonly drafts = new Map<string, unknown>();

    has(key: string): boolean {
        return this.drafts.has(key);
    }

    get<T>(key: string): T {
        return this.drafts.get(key) as T;
    }

    set(key: string, value: unknown): void {
        this.drafts.set(key, value);
    }

    /** The input was recorded or given up: start it over next time. */
    discard(key: string): void {
        this.drafts.delete(key);
    }

    clear(): void {
        this.drafts.clear();
    }
}

/** The one register declaration under way (the workspace allows one at a time). */
export const DECLARE_DRAFT = 'register-declare';
/** The one register row being corrected. */
export const REGISTER_EDIT_DRAFT = 'register-edit';
/** How far each Finding list is opened, and whether the history is shown. */
export const QA_VIEW_DRAFT = 'qa-view';
export const decisionDraftKey = (findingId: string): string => `decision:${findingId}`;

/**
 * useState kept in the book under `key`: it starts from what the book holds, and
 * every value the screen shows is written back. Give each key its own component
 * (a React key), so a component never changes key while it is mounted.
 */
export function useDraft<T>(book: DraftBook, key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>, () => void] {
    const [value, setValue] = useState<T>(() => (book.has(key) ? book.get<T>(key) : initial()));
    useEffect(() => {
        book.set(key, value);
    }, [book, key, value]);
    const discard = (): void => {
        book.discard(key);
        setValue(initial());
    };
    return [value, setValue, discard];
}
