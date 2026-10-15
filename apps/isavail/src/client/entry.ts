import "./styles.css";
import { Http, Runtime } from "foldkit";
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
  resources: Http.layer,
  devTools: { Message },
});

Runtime.run(application);
