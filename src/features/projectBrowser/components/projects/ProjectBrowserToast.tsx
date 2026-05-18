type ProjectBrowserToastProps = {
  kind: 'success' | 'error' | 'info';
  message: string;
};

export function ProjectBrowserToast({ kind, message }: ProjectBrowserToastProps) {
  return <div className={`rvpb-toast rvpb-toast--${kind}`}>{message}</div>;
}