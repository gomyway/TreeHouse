import { useLittleEnter, useLittleTool } from "@kabletv/little-react";
import { useState } from "react";

// A Little app: perception via data-little-* attributes, actuation via useLittleTool.
// Each tool name matches one in public/little/manifest.json.
export default function App() {
  const [count, setCount] = useState(0);

  useLittleEnter(() => {});
  useLittleTool("increment", () => {
    setCount((c) => c + 1);
    return { detail: "incremented", say: "Bumped it up." };
  });
  useLittleTool("reset", () => {
    setCount(0);
    return { detail: "reset", say: "Back to zero." };
  });

  return (
    <div className="app">
      <output className="count" data-little="readout" data-little-label="Count"
        data-little-data={JSON.stringify({ value: count })}>
        {count}
      </output>
      <div>
        <button data-little="control" data-little-action="increment" onClick={() => setCount((c) => c + 1)}>
          add one
        </button>
        <button data-little="control" data-little-action="reset" onClick={() => setCount(0)}>
          reset
        </button>
      </div>
    </div>
  );
}
