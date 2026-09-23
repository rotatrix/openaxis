/*
 *  IXWebSocketOpenInfo.h
 *  Author: Benjamin Sergeant
 *  Copyright (c) 2017-2019 Machine Zone, Inc. All rights reserved.
 */

#pragma once

#include "IXWebSocketHttpHeaders.h"
#include <cstdint>
#include <string>

namespace openaxis_ix
{
    struct WebSocketOpenInfo
    {
        std::string uri;
        WebSocketHttpHeaders headers;
        std::string protocol;

        WebSocketOpenInfo(const std::string& u = std::string(),
                          const WebSocketHttpHeaders& h = WebSocketHttpHeaders(),
                          const std::string& p = std::string())
            : uri(u)
            , headers(h)
            , protocol(p)
        {
            ;
        }
    };
} // namespace openaxis_ix
