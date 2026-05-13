// Worker tool registry. A.8 added screenshot/goto_url/js; B.1 adds the
// remaining 13 browser tools. Two more (`extract`, `cdp_raw`) are not yet
// implemented in `@basics/harness` — added with TODO comments in a follow-up.

import { registerTools, type ToolRegistry } from "@basics/shared";
import type { WorkerToolContext } from "./context.js";
import { screenshot } from "./screenshot.js";
import { goto_url } from "./goto_url.js";
import { js } from "./js.js";
import { new_tab } from "./new_tab.js";
import { click_at_xy } from "./click_at_xy.js";
import { type_text } from "./type_text.js";
import { fill_input } from "./fill_input.js";
import { press_key } from "./press_key.js";
import { scroll } from "./scroll.js";
import { wait_for_load } from "./wait_for_load.js";
import { wait_for_element } from "./wait_for_element.js";
import { wait_for_network_idle } from "./wait_for_network_idle.js";
import { http_get } from "./http_get.js";
import { ensure_real_tab } from "./ensure_real_tab.js";
import { upload_file } from "./upload_file.js";
import { dispatch_key } from "./dispatch_key.js";
import { extract } from "./extract.js";
import { cdp_raw } from "./cdp_raw.js";
import { read_file } from "./read_file.js";
import { write_file } from "./write_file.js";
import { edit_file } from "./edit_file.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { delete_file } from "./delete_file.js";
import { bash } from "./bash.js";
import { update_plan } from "./update_plan.js";
import { set_step_status } from "./set_step_status.js";
import { report_finding } from "./report_finding.js";
import { final_answer } from "./final_answer.js";
import { skill_write } from "./skill_write.js";
import { spawn_subagent } from "./spawn_subagent.js";
import { send_to_agent } from "./send_to_agent.js";
import { attach_artifact } from "./attach_artifact.js";
import { send_email } from "./send_email.js";
import { send_sms } from "./send_sms.js";
import { composio_list_tools } from "./composio_list_tools.js";
import { composio_call } from "./composio_call.js";
import { propose_automation } from "./propose_automation.js";
import { activate_automation } from "./activate_automation.js";

export {
  screenshot,
  goto_url,
  js,
  new_tab,
  click_at_xy,
  type_text,
  fill_input,
  press_key,
  scroll,
  wait_for_load,
  wait_for_element,
  wait_for_network_idle,
  http_get,
  ensure_real_tab,
  upload_file,
  dispatch_key,
  extract,
  cdp_raw,
  read_file,
  write_file,
  edit_file,
  glob,
  grep,
  delete_file,
  bash,
  update_plan,
  set_step_status,
  report_finding,
  final_answer,
  skill_write,
  spawn_subagent,
  send_to_agent,
  attach_artifact,
  send_email,
  send_sms,
  composio_list_tools,
  composio_call,
  propose_automation,
  activate_automation,
};
export type { WorkerToolContext, PublishEvent } from "./context.js";

export function buildWorkerToolRegistry(): ToolRegistry<WorkerToolContext> {
  return registerTools<WorkerToolContext>(
    screenshot,
    goto_url,
    js,
    new_tab,
    click_at_xy,
    type_text,
    fill_input,
    press_key,
    scroll,
    wait_for_load,
    wait_for_element,
    wait_for_network_idle,
    http_get,
    ensure_real_tab,
    upload_file,
    dispatch_key,
    extract,
    cdp_raw,
    read_file,
    write_file,
    edit_file,
    glob,
    grep,
    delete_file,
    bash,
    update_plan,
    set_step_status,
    report_finding,
    final_answer,
    skill_write,
    spawn_subagent,
    send_to_agent,
    attach_artifact,
    send_email,
    send_sms,
    composio_list_tools,
    composio_call,
    propose_automation,
    activate_automation,
  );
}
