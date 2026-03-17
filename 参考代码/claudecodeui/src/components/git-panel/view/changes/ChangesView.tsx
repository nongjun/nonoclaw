import { GitBranch, GitCommit, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConfirmationRequest, FileStatusCode, GitDiffMap, GitStatusResponse } from '../../types/types';
import { getAllChangedFiles, hasChangedFiles } from '../../utils/gitPanelUtils';
import CommitComposer from './CommitComposer';
import FileChangeList from './FileChangeList';
import FileSelectionControls from './FileSelectionControls';
import FileStatusLegend from './FileStatusLegend';

type ChangesViewProps = {
  isMobile: boolean;
  gitStatus: GitStatusResponse | null;
  gitDiff: GitDiffMap;
  isLoading: boolean;
  wrapText: boolean;
  isCreatingInitialCommit: boolean;
  onWrapTextChange: (wrapText: boolean) => void;
  onCreateInitialCommit: () => Promise<boolean>;
  onOpenFile: (filePath: string) => Promise<void>;
  onDiscardFile: (filePath: string) => Promise<void>;
  onDeleteFile: (filePath: string) => Promise<void>;
  onCommitChanges: (message: string, files: string[]) => Promise<boolean>;
  onGenerateCommitMessage: (files: string[]) => Promise<string | null>;
  onRequestConfirmation: (request: ConfirmationRequest) => void;
  onExpandedFilesChange: (hasExpandedFiles: boolean) => void;
};

export default function ChangesView({
  isMobile,
  gitStatus,
  gitDiff,
  isLoading,
  wrapText,
  isCreatingInitialCommit,
  onWrapTextChange,
  onCreateInitialCommit,
  onOpenFile,
  onDiscardFile,
  onDeleteFile,
  onCommitChanges,
  onGenerateCommitMessage,
  onRequestConfirmation,
  onExpandedFilesChange,
}: ChangesViewProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const changedFiles = useMemo(() => getAllChangedFiles(gitStatus), [gitStatus]);
  const hasExpandedFiles = expandedFiles.size > 0;

  useEffect(() => {
    if (!gitStatus || gitStatus.error) {
      setSelectedFiles(new Set());
      return;
    }

    // Preserve previous behavior: every fresh status snapshot reselects changed files.
    setSelectedFiles(new Set(getAllChangedFiles(gitStatus)));
  }, [gitStatus]);

  useEffect(() => {
    onExpandedFilesChange(hasExpandedFiles);
  }, [hasExpandedFiles, onExpandedFilesChange]);

  useEffect(() => {
    return () => {
      onExpandedFilesChange(false);
    };
  }, [onExpandedFilesChange]);

  const toggleFileExpanded = useCallback((filePath: string) => {
    setExpandedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const toggleFileSelected = useCallback((filePath: string) => {
    setSelectedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const requestFileAction = useCallback(
    (filePath: string, status: FileStatusCode) => {
      if (status === 'U') {
        onRequestConfirmation({
          type: 'delete',
          message: `删除未追踪文件 "${filePath}"？此操作无法撤销。`,
          onConfirm: async () => {
            await onDeleteFile(filePath);
          },
        });
        return;
      }

      onRequestConfirmation({
        type: 'discard',
          message: `放弃对 "${filePath}" 的所有更改？此操作无法撤销。`,
        onConfirm: async () => {
          await onDiscardFile(filePath);
        },
      });
    },
    [onDeleteFile, onDiscardFile, onRequestConfirmation],
  );

  const commitSelectedFiles = useCallback(
    (message: string) => {
      return onCommitChanges(message, Array.from(selectedFiles));
    },
    [onCommitChanges, selectedFiles],
  );

  const generateMessageForSelection = useCallback(() => {
    return onGenerateCommitMessage(Array.from(selectedFiles));
  }, [onGenerateCommitMessage, selectedFiles]);

  return (
    <>
      <CommitComposer
        isMobile={isMobile}
        selectedFileCount={selectedFiles.size}
        isHidden={hasExpandedFiles}
        onCommit={commitSelectedFiles}
        onGenerateMessage={generateMessageForSelection}
        onRequestConfirmation={onRequestConfirmation}
      />

      {gitStatus && !gitStatus.error && (
        <FileSelectionControls
          isMobile={isMobile}
          selectedCount={selectedFiles.size}
          totalCount={changedFiles.length}
          isHidden={hasExpandedFiles}
          onSelectAll={() => setSelectedFiles(new Set(changedFiles))}
          onDeselectAll={() => setSelectedFiles(new Set())}
        />
      )}

      {!gitStatus?.error && <FileStatusLegend isMobile={isMobile} />}

      <div className={`flex-1 overflow-y-auto ${isMobile ? 'pb-mobile-nav' : ''}`}>
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : gitStatus?.hasCommits === false ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <GitBranch className="h-7 w-7 text-muted-foreground/50" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-foreground">暂无提交</h3>
            <p className="mb-6 max-w-md text-sm text-muted-foreground">
              此仓库还没有任何提交。创建第一个提交以开始跟踪更改。
            </p>
            <button
              onClick={() => void onCreateInitialCommit()}
              disabled={isCreatingInitialCommit}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingInitialCommit ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  <span>正在创建初始提交...</span>
                </>
              ) : (
                <>
                  <GitCommit className="h-4 w-4" />
                  <span>创建初始提交</span>
                </>
              )}
            </button>
          </div>
        ) : !gitStatus || !hasChangedFiles(gitStatus) ? (
          <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
            <GitCommit className="mb-2 h-10 w-10 opacity-40" />
            <p className="text-sm">未检测到更改</p>
          </div>
        ) : (
          <div className={isMobile ? 'pb-4' : ''}>
            <FileChangeList
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              expandedFiles={expandedFiles}
              selectedFiles={selectedFiles}
              isMobile={isMobile}
              wrapText={wrapText}
              onToggleSelected={toggleFileSelected}
              onToggleExpanded={toggleFileExpanded}
              onOpenFile={(filePath) => {
                void onOpenFile(filePath);
              }}
              onToggleWrapText={() => onWrapTextChange(!wrapText)}
              onRequestFileAction={requestFileAction}
            />
          </div>
        )}
      </div>
    </>
  );
}
