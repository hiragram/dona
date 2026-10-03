import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskRequest, VerifiedTaskIssue, TaskRow } from "./task-execution.js";
import type { DispatcherDatabase } from "./database.js";
const exec = promisify(execFile);
export type GitHubQuery = (query:string,variables:Record<string,string|number>)=>Promise<any>;
export function githubQuery(executable:string):GitHubQuery {
  return async(query,variables)=>{
    const args=["api","graphql","-f",`query=${query}`];
    for(const [name,value] of Object.entries(variables)) args.push(typeof value==="number"?"-F":"-f",`${name}=${value}`);
    const {stdout}=await exec(executable,args,{timeout:15_000,maxBuffer:2_000_000});
    const response=JSON.parse(stdout);if(response.errors?.length||!response.data)throw new Error("task_github_query_failed");
    return response.data;
  };
}
export async function verifyTaskIssue(input:TaskRequest,query:GitHubQuery):Promise<VerifiedTaskIssue|undefined> {
  if(input.issue_number===undefined||input.workspace.kind!=="github")return;
  const [owner,name]=input.workspace.repository.split("/") as [string,string];
  const data=await query(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner issue(number:$number){id number}}}`,{owner,name,number:input.issue_number});
  const repo=data.repository,issue=repo?.issue;
  if(typeof issue?.id!=="string"||issue.number!==input.issue_number||repo.nameWithOwner.toLowerCase()!==input.workspace.repository.toLowerCase())throw new Error("task_issue_identity_unverified");
  const verified:VerifiedTaskIssue={node_id:issue.id,repository:repo.nameWithOwner,number:issue.number};
  if(!input.project)return verified;
  let cursor:string|undefined;
  do {
    const page=await query(`query($id:ID!,$cursor:String){node(id:$id){... on Issue{projectItems(first:100,after:$cursor){nodes{id project{id number owner{... on Organization{login} ... on User{login}} fields(first:100){nodes{... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}}} pageInfo{hasNextPage}}}} pageInfo{hasNextPage endCursor}}}}}`,{id:issue.id,...(cursor?{cursor}:{})});
    const connection=page.node?.projectItems;if(!connection)throw new Error("task_project_identity_unverified");
    const matches=connection.nodes.filter((n:any)=>n.project.number===input.project!.number&&n.project.owner.login.toLowerCase()===input.project!.owner.toLowerCase());
    if(matches.length>1)throw new Error("task_project_identity_ambiguous");
    if(matches.length) {
      const item=matches[0],fields=item.project.fields;if(fields.pageInfo.hasNextPage)throw new Error("task_project_fields_truncated");
      const ids=fields.nodes.filter((f:any)=>f.name==="Dona Task ID"&&f.dataType==="TEXT");
      const statuses=fields.nodes.filter((f:any)=>f.name==="Status"&&f.dataType==="SINGLE_SELECT");
      if(ids.length!==1||statuses.length!==1)throw new Error("task_project_fields_required");
      const options:Record<string,string>={};
      for(const value of ["Todo","In Progress","Merge Ready"]){const found=statuses[0].options.filter((o:any)=>o.name===value);if(found.length!==1)throw new Error("task_project_status_required");options[value]=found[0].id;}
      verified.project={issue_id:issue.id,item_id:item.id,project_id:item.project.id,task_field_id:ids[0].id,status_field_id:statuses[0].id,options,completion_status:input.project.completion_status};return verified;
    }
    if(!connection.pageInfo.hasNextPage)break;
    cursor=connection.pageInfo.endCursor;if(!cursor)throw new Error("task_project_cursor_missing");
  } while(cursor);
  throw new Error("task_project_item_missing");
}

/** Projection writes never decide execution ownership. An ambiguous write is read back, not resent. */
export class TaskProjector {
  constructor(private readonly database:DispatcherDatabase,private readonly query:GitHubQuery) {}
  async sync(task:TaskRow):Promise<void> {
    if(!task.project_json||task.project_state==="synced"||task.project_state==="conflict")return;
    const binding=JSON.parse(task.project_json);
    const data=await this.query(`query($id:ID!){node(id:$id){... on ProjectV2Item{id project{id} content{... on Issue{id}} task:fieldValueByName(name:"Dona Task ID"){... on ProjectV2ItemFieldTextValue{text}} progress:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId}}}}}`,{id:binding.item_id});
    const item=data.node;
    if(item?.project?.id!==binding.project_id||item?.content?.id!==binding.issue_id||(item.task?.text&&item.task.text!==task.task_id)){this.database.tasks.projectState(task,"conflict");return;}
    // Completed means accepted Task outcome, not automatically merged/deployed.
    const status=task.progress==="todo"?"Todo":task.state==="completed"?binding.completion_status:"In Progress";
    const expected=binding.options[status];
    const intent=this.database.tasks.projectIntent(task.task_id);
    if(intent) {
      const actual=intent.kind==="text"?item.task?.text:item.progress?.optionId;
      if(actual===intent.value)this.database.tasks.settleProjection(task.task_id);
      else this.database.tasks.projectState(task,"unknown");
      return;
    }
    if(item.task?.text===task.task_id&&item.progress?.optionId===expected){this.database.tasks.projectState(task,"synced");return;}
    const kind=item.task?.text===task.task_id?"singleSelectOptionId":"text";
    const field=kind==="text"?binding.task_field_id:binding.status_field_id;
    const value=kind==="text"?task.task_id:expected;
    if(!this.database.tasks.claimProjection(task,field,kind,value))return;
    await this.query(`mutation($project:ID!,$item:ID!,$field:ID!,$value:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{${kind}:$value}}){projectV2Item{id}}}`,{project:binding.project_id,item:binding.item_id,field,value});
    // Even a successful mutation is settled by the next read-back. A lost response is never resent.
  }
}
