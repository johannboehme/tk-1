import { type Capabilities, describeCapability } from "../core/capabilities";

interface Props {
  missing: ReadonlyArray<keyof Capabilities>;
}

export function BrowserTooOld({ missing }: Props) {
  return (
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <h1 className="text-2xl font-semibold">This browser is too old.</h1>
      <p>
        TK-1 runs everything in your browser — sync, render, and storage all
        happen locally so your video never has to upload. That requires a few
        modern web platform features your browser is missing:
      </p>
      <ul className="list-disc space-y-1 pl-6">
        {missing.map((key) => (
          <li key={key}>{describeCapability(key)}</li>
        ))}
      </ul>
      <p>Please use a recent version of:</p>
      <ul className="list-disc space-y-1 pl-6">
        <li>Chrome or Edge 102+ (May 2022)</li>
        <li>Firefox 111+ (March 2023)</li>
        <li>Safari 16.4+ (March 2023, desktop and iOS)</li>
      </ul>
    </main>
  );
}
