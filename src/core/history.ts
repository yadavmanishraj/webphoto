import { Command, EditorDocument, LIMITS } from './contracts';

export interface HistoryEntry { label: string; at: number }

/**
 * Undo/redo with classic branching: executing a new command after undos
 * discards the redo stack. Entries cap at LIMITS.maxHistoryEntries.
 */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  onChange?: () => void;

  execute(cmd: Command, doc: EditorDocument): void {
    cmd.do(doc);
    this.undoStack.push(cmd);
    if (this.undoStack.length > LIMITS.maxHistoryEntries) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }
  /** For live drags: apply without recording (pair with commitSnapshot). */
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undo(doc: EditorDocument): boolean {
    const cmd = this.undoStack.pop(); if (!cmd) return false;
    cmd.undo(doc); this.redoStack.push(cmd); this.onChange?.(); return true;
  }
  redo(doc: EditorDocument): boolean {
    const cmd = this.redoStack.pop(); if (!cmd) return false;
    cmd.do(doc); this.undoStack.push(cmd); this.onChange?.(); return true;
  }
  entries(): HistoryEntry[] { return this.undoStack.map(c => ({ label: c.label, at: 0 })); }
  redoLabels(): string[] { return this.redoStack.map(c => c.label); }
  clear(): void { this.undoStack = []; this.redoStack = []; this.onChange?.(); }
  get depth(): number { return this.undoStack.length; }
}
