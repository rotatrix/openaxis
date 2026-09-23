/*
 *  IXSocketFactory.cpp
 *  Author: Benjamin Sergeant
 *  Copyright (c) 2019 Machine Zone, Inc. All rights reserved.
 */

#include "IXSocketFactory.h"

#include "IXUniquePtr.h"
#ifdef OPENAXIS_IXWEBSOCKET_USE_TLS

#ifdef OPENAXIS_IXWEBSOCKET_USE_MBED_TLS
#include "IXSocketMbedTLS.h"
#elif defined(OPENAXIS_IXWEBSOCKET_USE_OPEN_SSL)
#include "IXSocketOpenSSL.h"
#elif __APPLE__
#include "IXSocketAppleSSL.h"
#endif

#else

#include "IXSocket.h"

#endif

namespace openaxis_ix
{
    std::unique_ptr<Socket> createSocket(bool tls,
                                         int fd,
                                         std::string& errorMsg,
                                         const SocketTLSOptions& tlsOptions)
    {
        (void) tlsOptions;
        errorMsg.clear();
        std::unique_ptr<Socket> socket;

        if (!tls)
        {
            socket = openaxis_ix::make_unique<Socket>(fd);
        }
        else
        {
#ifdef OPENAXIS_IXWEBSOCKET_USE_TLS
#if defined(OPENAXIS_IXWEBSOCKET_USE_MBED_TLS)
            socket = openaxis_ix::make_unique<SocketMbedTLS>(tlsOptions, fd);
#elif defined(OPENAXIS_IXWEBSOCKET_USE_OPEN_SSL)
            socket = openaxis_ix::make_unique<SocketOpenSSL>(tlsOptions, fd);
#elif defined(__APPLE__)
            socket = openaxis_ix::make_unique<SocketAppleSSL>(tlsOptions, fd);
#endif
#else
            errorMsg = "TLS support is not enabled on this platform.";
            return nullptr;
#endif
        }

        if (!socket->init(errorMsg))
        {
            socket.reset();
        }

        return socket;
    }
} // namespace openaxis_ix
