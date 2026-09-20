# 承認recordのcanonical codec

## 範囲

`encodeApprovalRecord`/`decodeApprovalRecord`は、既存approval schemaのrequest、decision、consume、execution attempt、notification、decision event outbox、presentation updateの7種を、version付きのcanonical wrapperへ変換する。#16の部分対応であり、repository、broker、一覧index、現在の監査rootへの登録はまだ接続しない。

wrapperは`codec_version: 1`、固定`scope`、`kind`、`row`からなる。scopeはinstance/workspaceで分離する。rowの型・state・ref・安全整数・UTC・nullabilityを確認し、未知kind/version/fieldを拒否する。全体は520 KiB以下とし、canonical snapshotをJSON stringとして再escapeする分を含む。保存bytesの空白・field順序変更・重複JSON keyはdecode時に拒否する。encodeはfield順序に依存せず同じcanonical bytesを作る。

## hashとpoint key

record digestは用途を分けたSHA-256へwrapper全体を結び、[metadata tree](approval-metadata-tree.md)へ保存するrow digestの候補になる。point keyも別用途のhashでscope/kind/主キーへ結び、`record_`付きのopaque文字列にする。request/decision/consumeの主キーはSQLiteと同じrequest ID、残りはattempt/notification/event/update IDである。

これは一覧の完全性や最新root、別unique columnからの検索結果の完全性を証明しない。後続repositoryは認証済みmanifest/secondary indexとrowを同じ監査transactionで更新し、SQLが返したrowだけを検証して全件と主張しない。

## 検証する重複fieldと期限

requestのsnapshotは既存codecでcanonical bytes、semantic hash、creation key、instance/workspace、policy revision、workspace binding revisionを照合する。snapshotは本文を持たず、既存HMACと暗号化payloadのopaque参照を持つ。

request期限は作成後15分以内。承認後のconsume期限は別の5分窓なので、request expiryを超えたという理由だけでは拒否しない。row単体で検証できる順序・上限を検証し、厳密な`decision.decided_at + 5分`の結合や現在時刻での可否は、decisionとrequestを持つrepository/brokerで確認する。execution expiryはclaim後、payload保持はclaimから24時間以内とする。

decisionはapprove/rejectとsupervisor/presentation revision、cancelとrequester、expireとsystemの同一row条件を守る。notificationのsent/message ref、eventのdelivered/時刻、dispatching系のfenceも確認する。failure codeは既存audit reasonの固定語彙、message/receipt refはadapterが保存するopaque handleとし、URLやraw errorを入れない。model versionは128文字以内の機械識別子で、URLや自由文を受けない。

## 認証・認可との境界

保存されたrequest_source、actor ID、binding IDはdataであり、本人性の証明ではない。snapshot構造の照合用contextを保存dataから組み立てても、認証済みsourceを作ったとは扱わない。brokerは現在の認証済みtransport provenance、server-side binding、policy、visibility、clockと監査rootを別途確認する。cross-row foreign key、decisionとconsume、executionのone-shot性、正当なstate遷移もcodecだけでは成立しない。

canonical文字列は内部保存・完全性計算用で、API、監査event、outbox本文へwrapper全文を流さない。入力はboundedなpassive dataに限定し、getter/Proxy/callbackを検証中に実行しない。例外は固定`approval_record_unverified`で返し、入力本文を引き継がない。

## 検証

7種のround-tripとfield順序、scope/kind/主キー分離、snapshotの重複fieldと最大thread件数、request/consume TTL、outboxの同一row条件、危険なref/raw error、未知field/version、重複key、過大wire、実行可能な入力をfixtureで確認する。実credential、production DB、外部write、actorのlive認証を行うテストではない。
