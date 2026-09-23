/*
 *  IXSelectInterruptFactory.h
 *  Author: Benjamin Sergeant
 *  Copyright (c) 2019 Machine Zone, Inc. All rights reserved.
 */

#pragma once

#include <memory>

namespace openaxis_ix
{
    class SelectInterrupt;
    using SelectInterruptPtr = std::unique_ptr<SelectInterrupt>;
    SelectInterruptPtr createSelectInterrupt();
} // namespace openaxis_ix
