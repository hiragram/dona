# OS clock観測source

`NativeClockSource`は、共通protected clockへboot ID、suspendを含むcontinuous milliseconds、UTC観測値を渡す固定native helperである。macOSは`kern.bootsessionuuid`と`mach_continuous_time`、Linuxはkernelのboot IDと`CLOCK_BOOTTIME`を使う。sleep中も進む性質は[Appleの公開header](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/mach_time.h)と[Linux kernelの時刻資料](https://www.kernel.org/doc/html/latest/core-api/timekeeping.html)に基づく。

helperは引数を受け付けず、boot IDを前後で照合する。UTC読取を挟むcontinuous clockの測定windowが10msを超える、bootが変わる、値が巻き戻る、取得や型変換が失敗する場合は観測値を返さない。processごとに固定UUIDを生成したり、Node process起動時刻をOS boot IDの代わりにしない。

buildは固定のC sourceとcompiler引数を使い、platform/arch/source hash/binary hashをmanifestへ記録する。runtimeは固定位置のmanifest・source・binaryを照合し、通常fileでないもの、symlink/hardlink、group/world書込可能なfileを内容の読取前に拒否する。sourceは16 KiB、binaryは1 MiB、manifestは2 KiBを上限とする。実行時の環境は固定PATHとlocaleだけ、shellなし、2秒、1024 byte上限とし、timeout時は当該helperをSIGKILLする。追加引数、任意path、環境変数、commandを外部入力から渡さない。

helperの失敗・stderr・signal・timeout・不正JSON・重複field・未知fieldを共通の安全なerrorへ変換し、出力や内部pathをerrorへ転載しない。失敗時にwall clockだけの観測へfallbackせず、自動再試行しない。

これはOSの観測sourceである。DB外のrollback-resistant high-water mark/CAS、key lifecycle、boot変更時の全失効と二者operator復旧、runtimeへの有効化は別途必要であり、OS観測の成功だけでsecurity decisionを許可しない。通常の二つのprocess間での観測は検証するが、実suspend/reboot実験、production変更、credential作成は行わない。
