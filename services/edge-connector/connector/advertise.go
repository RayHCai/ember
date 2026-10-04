package connector

import (
	"fmt"
	"net"
	"strconv"

	"github.com/libp2p/zeroconf/v2"

	"ember/internal/edgeproto"
)

// Advertise announces the drone link over mDNS so drones on this network find the connector
// without being given its address. Shut the returned server down to withdraw the announcement.
func Advertise(edgeServerID, listenAddr string) (*zeroconf.Server, error) {
	port, err := listenPort(listenAddr)
	if err != nil {
		return nil, err
	}
	return zeroconf.Register(edgeServerID, edgeproto.EdgeServiceType, "local.", port, AdvertisedTXT(edgeServerID), nil)
}

// AdvertisedTXT is the TXT record drones read the edge server's id and link path from.
func AdvertisedTXT(edgeServerID string) []string {
	return []string{
		edgeproto.EdgeTxtID + "=" + edgeServerID,
		edgeproto.EdgeTxtPath + "=" + edgeproto.DroneLinkPath,
	}
}

func listenPort(listenAddr string) (int, error) {
	_, p, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return 0, fmt.Errorf("listen address %q: %w", listenAddr, err)
	}
	port, err := strconv.Atoi(p)
	if err != nil || port <= 0 || port > 65535 {
		return 0, fmt.Errorf("listen address %q: no fixed port to advertise", listenAddr)
	}
	return port, nil
}
