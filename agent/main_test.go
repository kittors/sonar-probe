package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 只有 410 才算"这台机器被面板删了"。
//
// 其余非 2xx 都可能是一时的：token 配错了正在改、面板在重启、反代抖了一下。
// 误判成被删，agent 会掉进十分钟一次的慢节奏，白白丢掉那一段数据。
func TestIsRemovedOnlyFor410(t *testing.T) {
	cases := []struct {
		code int
		want bool
	}{
		{http.StatusGone, true},
		{http.StatusBadRequest, false},
		{http.StatusUnauthorized, false},
		{http.StatusForbidden, false},
		{http.StatusConflict, false},
		{http.StatusTooManyRequests, false},
		{http.StatusServiceUnavailable, false},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(c.code)
			_, _ = w.Write([]byte(`{"error":"面板的说明"}`))
		}))
		err := postJSON(context.Background(), srv.URL, map[string]any{}, nil)
		srv.Close()

		if err == nil {
			t.Fatalf("%d：应当返回错误", c.code)
		}
		if got := isRemoved(err); got != c.want {
			t.Errorf("%d：isRemoved = %v，应为 %v", c.code, got, c.want)
		}
		// 这一行会原样进 journald，安装脚本靠 grep 里面的状态码判断出了什么事
		msg := err.Error()
		if !strings.HasPrefix(msg, fmt.Sprint(c.code)) || !strings.Contains(msg, "面板的说明") {
			t.Errorf("%d：错误文本 %q 丢了状态码或面板的说明", c.code, msg)
		}
	}
}

func TestSpokenDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{
		10 * time.Minute: " 10 分钟",
		90 * time.Second: " 90 秒",
		15 * time.Second: " 15 秒",
	} {
		if got := spokenDuration(d); got != want {
			t.Errorf("spokenDuration(%s) = %q，应为 %q", d, got, want)
		}
	}
}

// 面板连不上不等于被删了。
func TestIsRemovedIgnoresNetworkErrors(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // 关掉之后这个地址必然拒绝连接

	err := postJSON(context.Background(), url, map[string]any{}, nil)
	if err == nil {
		t.Fatal("连不上的地址应当返回错误")
	}
	if isRemoved(err) {
		t.Errorf("网络错误被当成了被删除：%v", err)
	}
}
