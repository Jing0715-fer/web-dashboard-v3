'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div style={{ fontFamily: 'system-ui, sans-serif', padding: '40px', textAlign: 'center' }}>
          <h2>Something went wrong!</h2>
          <p style={{ color: '#666' }}>{error.message || 'An unexpected error occurred'}</p>
          <button
            onClick={reset}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#059669',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
