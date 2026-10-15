import "./styles.css";
import { Runtime } from "foldkit";
import { init, update } from "./main.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { view } from "./view.ts";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  devTools: { Message },
});

Runtime.run(application);
