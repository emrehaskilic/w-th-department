interface ConfigurationErrorProps {
  message: string;
}

const ConfigurationError = ({ message }: ConfigurationErrorProps) => {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-red-500/40 bg-zinc-900/90 p-6 shadow-lg">
        <h1 className="text-xl font-semibold text-red-400">Yapilandirma Hatasi</h1>
        <p className="mt-3 text-sm text-zinc-200">{message}</p>
        <p className="mt-2 text-xs text-zinc-400">
          README_SETUP.md dosyasindaki kurulum adimlarini takip edin.
        </p>
      </div>
    </div>
  );
};

export default ConfigurationError;
