#!/bin/bash
# Crude websocket server that just sends/receivs ping/pongs.
# Bash doesn't handle '\0' very well internall so switching to node.

function recode {
  s="${1}258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
  printf "$s" | openssl dgst -sha1 -binary | base64
}

# ASCII/byte stuff
_CHR=()
for a in {0..255}; do _CHR[a]=$(printf '\\x%02x' $a); done
_CHRC=()
for a in {0..31};    do _CHRC[a]=$(printf %02x      $a); done
for a in {32..126};  do _CHRC[a]=$(printf %s "${_CHR[$a]}"  ); done
for a in {127..255}; do _CHRC[a]=$(printf %02x      $a); done
function chr  { printf "${_CHR[$1]}"; }   # char from integer
function chrc { printf "${_CHRC[$1]}"; }  # char from integer or HEX string if not printable
function ascd { printf %d "'$1"; }        # ASCII value of char
function asch { printf %02x "'$1"; }        # hex value of char

function decho {
  1>&2 echo -en "$*"
}


function doit0 {
  local h v swk c=''
  local line=''
  local state=train
  local pong=''
#| tee $(while read -rN 1 x; do (1>&2 echo -en "$(chrc $(ascd "$x")) "); done)
  coproc nc -l -p 7199 # writes to io[0], reads from io[1]
  local nco=${COPROC[0]}
  local nci=${COPROC[1]}
  
  while :; do
      c=''
      read -rN 1 -t 1 c
      if [ $state == train ]; then
        if [ "$c" != $'\r' ]; then
          if [ "$c" == $'\n' ]; then
            decho "\n[$state<]$line"
            if [ "$line" == "" ]; then
              printf "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${swk}\r\n\r\n" | tee >(while read x; do decho "\n[$state>]$x"; done)

              # send close
              #printf $'\x08' #| tee $((1>&2 echo -en "[$state>]"); while read -rN 1 x; do 1>&2 echo -en "[$(chrc $(ascd "$x")) $(asch "$x")] "; done; (1>&2 echo))

              # Send HI
              state=text
              printf '\x81\x1dWelcome To Death Match 640!!!' | tee >(decho "\n[$state>]"; while read -rN 1 x; do decho " [$(chrc $(ascd "$x")) $(asch "$x")]"; done)
              sleep .5
              printf '\x81\x02!!' | tee >(decho "\n[$state>]"; while read -rN 1 x; do decho " [$(chrc $(ascd "$x")) $(asch "$x")]"; done)

              state=go
            else
              read h v <<<$line
              [ "$h" == "Sec-WebSocket-Key:" ] && swk=$(recode $v)
            fi
            line=''
          else
            line="$line$c"
          fi
        fi
      elif (( 0 == ${#c} )); then
        # send ping at random intervals when there's no traffic
        state=ping
        (( RANDOM % 10 == 0 )) && printf '\x89\x04\x00\00\00\00' | tee >(decho "\n[$state>]"; while read -rN 1 x; do decho " [$(chrc $(ascd "$x")) $(asch "$x")]"; done)
        state=go
      elif [[ $state == pong ]]; then # in the pong state, we're scanning a pong message.  assemble into a debug message
        pong="$pong"$(asch $c)
        if (( ${#pong} == 18 )); then
          printf '\x81\x16PONG'$pong
          state=go
        fi
      elif [[ $(asch "$c") == "88" ]]; then
        kill $((BASHPID+1)) # exit right away
        break;
      elif [[ $(asch "$c") == "8a" ]]; then
        state=pong
        pong=''
      else
        decho "\e[32m($(asch "$c") $(chrc $(ascd "$c")))\e[0m "
        state=go
      fi

    done <&$nco >&$nci
  #} | ( while read -rN 1 cc; do [ "$cc" == "" ] && { 1>&2 echo not killing child $((BASHPID+1)); kill $((BASHPID+1)); }; (1>&2 echo -en "$cc"); echo -en "$cc"; done | { nc -l -p 7199 >f; })
}

#while :; do doit0; echo ===============; done
doit0
