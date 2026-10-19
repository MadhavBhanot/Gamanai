import { port } from "./config";
import { app } from "./app";

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
