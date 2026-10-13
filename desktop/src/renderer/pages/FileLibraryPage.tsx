import { ArrowLeft, FileText, Plus, Shrink, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LibraryFile, LibraryFileCategory } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

const fileSize = (bytes: number): string => bytes >= 1_048_576
  ? `${(bytes / 1_048_576).toFixed(1)} MB`
  : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

interface FileLibraryPageProps { onCollapse(): void }

export function FileLibraryPage({ onCollapse }: FileLibraryPageProps): JSX.Element {
  const setPage = useAppStore((state) => state.setPage);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<LibraryFileCategory | null>(null);
  const [error, setError] = useState('');

  const refresh = async (): Promise<void> => setFiles(await window.electronAPI.listLibraryFiles());
  useEffect(() => {
    let disposed = false;
    void window.electronAPI.listLibraryFiles()
      .then((items) => { if (!disposed) setFiles(items); })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Could not load saved files.'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  const upload = async (category: LibraryFileCategory): Promise<void> => {
    setUploading(category); setError('');
    try {
      const file = await window.electronAPI.uploadLibraryFile(category);
      if (file) await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save the selected file.'); }
    finally { setUploading(null); }
  };

  const remove = async (file: LibraryFile): Promise<void> => {
    if (!window.confirm(`Delete ${file.name} from saved files? Existing sessions will not be changed.`)) return;
    setError('');
    try {
      await window.electronAPI.deleteLibraryFile(file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete the saved file.'); }
  };

  const section = (category: LibraryFileCategory, title: string, description: string): JSX.Element => {
    const items = files.filter((file) => file.category === category);
    return <section className="library-section">
      <div className="library-section-heading"><div><h2>{title}</h2><p>{description}</p></div><button disabled={uploading !== null} onClick={() => void upload(category)}><Plus size={14}/>{uploading === category ? 'Reading...' : 'Upload'}</button></div>
      {loading ? <div className="library-empty">Loading saved files...</div> : items.length === 0
        ? <div className="library-empty">No saved files</div>
        : <div className="library-list">{items.map((file) => <div className="library-file" key={file.id}>
          <span className="library-file-icon"><FileText size={15}/></span>
          <div><strong>{file.name}</strong><small>{fileSize(file.sizeBytes)} · {file.available ? 'Saved locally' : 'Cached context available'}</small></div>
          <button aria-label={`Delete ${file.name}`} title="Delete saved file" onClick={() => void remove(file)}><Trash2 size={13}/><span>Delete</span></button>
        </div>)}</div>}
    </section>;
  };

  return <main className="file-library-page">
    <header className="file-library-header">
      <button className="library-back" onClick={() => setPage('home')}><ArrowLeft size={16}/>Dashboard</button>
      <div><span className="dashboard-mark">M</span><strong>Files</strong></div>
      <div className="library-header-actions">
        <button className="library-collapse" aria-label="Collapse Cluera AI" title="Collapse to floating logo" onClick={onCollapse}><Shrink size={16}/></button>
        <button className="library-close" aria-label="Close Cluera AI" title="Close Cluera AI" onClick={() => void window.electronAPI.closeWindow()}><X size={17}/></button>
      </div>
    </header>
    <div className="file-library-scroll">
      <div className="library-intro"><p>LOCAL FILE LIBRARY</p><h1>Reusable interview context</h1><span>Files stay on this device and can be attached to future sessions.</span></div>
      {error && <div className="form-error library-error">{error}</div>}
      <div className="library-sections">
        {section('resume', 'Resumes', 'PDF, DOCX, TXT, and Markdown resumes available to new sessions.')}
        {section('supporting', 'Supporting / Context', 'PDF, DOCX, TXT, and Markdown context files.')}
      </div>
    </div>
  </main>;
}
