package connector

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// PublicURL is the URL edge-manager reaches this connector at: the configured one, or the address
// of the interface that routes to the manager plus the port this connector listens on.
func PublicURL(configured, listenAddr, managerURL string) (string, error) {
	if configured != "" {
		u, err := url.Parse(configured)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "", fmt.Errorf("public url %q is not an http(s) URL", configured)
		}
		return strings.TrimSuffix(configured, "/"), nil
	}
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return "", fmt.Errorf("listen address %q: %w", listenAddr, err)
	}
	if ip := net.ParseIP(host); ip != nil && !ip.IsUnspecified() {
		return "http://" + net.JoinHostPort(host, port), nil
	}
	ip, err := routeTo(managerURL)
	if err != nil {
		return "", fmt.Errorf("public url: %w (set EMBER_EDGE_PUBLIC_URL)", err)
	}
	return "http://" + net.JoinHostPort(ip.String(), port), nil
}

// routeTo is the local address the OS would send from to reach the manager. A UDP "dial" only
// picks the route; no packet leaves.
func routeTo(managerURL string) (net.IP, error) {
	u, err := url.Parse(managerURL)
	if err != nil || u.Hostname() == "" {
		return nil, fmt.Errorf("edge-manager url %q has no host", managerURL)
	}
	port := u.Port()
	if port == "" {
		port = "80"
	}
	conn, err := net.Dial("udp", net.JoinHostPort(u.Hostname(), port))
	if err != nil {
		return nil, fmt.Errorf("no route to edge-manager %s: %w", u.Host, err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP, nil
}
