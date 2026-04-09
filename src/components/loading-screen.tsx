'use client';

import Image from 'next/image';

interface LoadingScreenProps {
  message?: string;
}

/**
 * Branded full-screen loading state.
 * Shows the VexPro logo (light/dark variant) with a soft pulse and a
 * sliding progress bar. Uses keyframes defined in globals.css so it
 * works without external animation libraries.
 */
export function LoadingScreen({ message }: LoadingScreenProps) {
  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center px-6 vex-fade-in">
      <div className="flex flex-col items-center gap-6">
        <div className="vex-logo-pulse">
          <Image
            src="/vex-logofull.png"
            alt="VexPro"
            width={180}
            height={50}
            priority
            className="object-contain block dark:hidden"
          />
          <Image
            src="/vex-logofull-white.png"
            alt="VexPro"
            width={180}
            height={50}
            priority
            className="object-contain hidden dark:block"
          />
        </div>
        <div className="vex-bar-track" role="progressbar" aria-label="Cargando">
          <div className="vex-bar-fill" />
        </div>
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
      </div>
    </div>
  );
}

interface LoadingErrorProps {
  message: string;
  onRetry: () => void;
}

/**
 * Branded error screen shown when initial data load fails or times out.
 */
export function LoadingError({ message, onRetry }: LoadingErrorProps) {
  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center px-6 vex-fade-in">
      <div className="flex flex-col items-center gap-5 text-center max-w-md">
        <div>
          <Image
            src="/vex-logofull.png"
            alt="VexPro"
            width={160}
            height={44}
            priority
            className="object-contain block dark:hidden opacity-80"
          />
          <Image
            src="/vex-logofull-white.png"
            alt="VexPro"
            width={160}
            height={44}
            priority
            className="object-contain hidden dark:block opacity-80"
          />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            No pudimos cargar los datos
          </p>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
        <button
          onClick={onRetry}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
