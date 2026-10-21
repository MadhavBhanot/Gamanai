// Must load first: Langfuse/OpenTelemetry has to patch before the AI SDK is imported
import "./instrumentation";
import { port } from "./config";
import { app } from "./app";

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
