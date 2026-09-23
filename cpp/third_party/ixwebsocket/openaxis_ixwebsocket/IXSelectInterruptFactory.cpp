/*
 *  IXSelectInterruptFactory.cpp
 *  Author: Benjamin Sergeant
 *  Copyright (c) 2019 Machine Zone, Inc. All rights reserved.
 */

#include "IXSelectInterruptFactory.h"

#include "IXUniquePtr.h"
#if _WIN32
#include "IXSelectInterruptEvent.h"
#else
#include "IXSelectInterruptPipe.h"
#endif

namespace openaxis_ix
{
    SelectInterruptPtr createSelectInterrupt()
    {
#ifdef _WIN32
        return openaxis_ix::make_unique<SelectInterruptEvent>();
#else
        return openaxis_ix::make_unique<SelectInterruptPipe>();
#endif
    }
} // namespace openaxis_ix
