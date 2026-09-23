# A manylinux build may link OpenSSL 1.1 while the desktop has only OpenSSL 3.
# Copy its crypto/compression dependencies beside the normal demo output.
file(GET_RUNTIME_DEPENDENCIES EXECUTABLES "${DEMO}"
  RESOLVED_DEPENDENCIES_VAR dependencies
  UNRESOLVED_DEPENDENCIES_VAR unresolved)
get_filename_component(output "${DEMO}" DIRECTORY)
foreach(library IN LISTS dependencies)
  get_filename_component(name "${library}" NAME)
  if(name MATCHES "^lib(crypto|ssl|z)\\.so")
    get_filename_component(source_dir "${library}" DIRECTORY)
    if(NOT source_dir STREQUAL output)
      file(COPY "${library}" DESTINATION "${output}" FOLLOW_SYMLINK_CHAIN)
    endif()
  endif()
endforeach()
foreach(library IN LISTS unresolved)
  if(library MATCHES "^lib(crypto|ssl|z)\\.so")
    message(FATAL_ERROR "Missing demo runtime dependency: ${library}")
  endif()
endforeach()
